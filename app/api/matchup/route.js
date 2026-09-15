import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { neon } from '@neondatabase/serverless';
import { teamGameDates } from '@/lib/schedule';
import { SLEEPER_OWNERS } from '@/lib/sleeper-owners';
import { expectedLineup, replacementTable, DEFAULT_SLOTS } from '@/lib/lineup';

export const dynamic = 'force-dynamic';

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

/**
 * Both lineups for one matchup, so people can see what they are betting on.
 *
 * Fetched on demand rather than baked into the board: the board already ships
 * a hundred markets, and most of them are never opened. This is one request
 * when someone actually asks.
 */
export async function GET(request) {
  if (!(await currentBettor())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const homeRoster = Number(searchParams.get('home'));
  const awayRoster = Number(searchParams.get('away'));
  const week = Number(searchParams.get('week'));
  if (!homeRoster || !awayRoster || !week) {
    return NextResponse.json({ error: 'Missing matchup.' }, { status: 400 });
  }

  try {
    const [state, users, rosters, matchups, league] = await Promise.all([
      fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${week}`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`).then((r) => r.json()).catch(() => null),
    ]);
    const season = Number(state.season);
    const slots = Array.isArray(league?.roster_positions) && league.roster_positions.length
      ? league.roster_positions
      : DEFAULT_SLOTS;

    const [projRows, gameDates] = await Promise.all([
      fetch(
        `https://api.sleeper.com/projections/nfl/${season}/${week}` +
          `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
          `&position[]=K&position[]=DEF&order_by=pts_ppr`,
      ).then((r) => r.json()),
      teamGameDates(season, week),
    ]);

    const info = {};
    for (const r of projRows) {
      if (!r.player_id) continue;
      info[r.player_id] = {
        name: `${r.player?.first_name ?? ''} ${r.player?.last_name ?? ''}`.trim(),
        position: r.player?.position ?? '?',
        team: r.player?.team ?? null,
        opponent: r.opponent ?? null,
        injury: r.player?.injury_status || null,
        projection: typeof r?.stats?.pts_ppr === 'number' ? r.stats.pts_ppr : null,
      };
    }

    const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
    const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

    // What a slot nobody on a roster can fill is worth: the waiver wire.
    const rostered = new Set(rosters.flatMap((r) => (r.players ?? []).map(String)));
    const replacement = replacementTable({
      ids: Object.keys(info),
      rostered,
      positionOf: (id) => (info[id]?.position === '?' ? null : info[id]?.position ?? null),
      projectionOf: (id) => {
        const p = info[id];
        if (!p) return 0;
        if (p.team && !gameDates[p.team]) return 0;
        return p.projection ?? 0;
      },
    });

    const side = (rosterId) => {
      const roster = rosterById[rosterId];
      const owner = SLEEPER_OWNERS[roster?.owner_id];
      const user = userById[roster?.owner_id];
      const m = matchups.find((x) => x.roster_id === rosterId);
      // The lineup the matchup is PRICED on: locked starters as set, every
      // open slot filled with the best available player (lib/lineup.js).
      // A starter with points on the board has kicked off and is locked.
      const setStarters = (m?.starters ?? []).map((x) => (x && x !== '0' ? String(x) : null));
      const pointsOf = (id) => {
        const i = setStarters.indexOf(id);
        return i >= 0 ? Number(m?.starters_points?.[i] ?? 0) : 0;
      };
      const entries = expectedLineup(m ?? {}, {
        replacement,
        slots,
        positionOf: (id) => info[id]?.position ?? null,
        projectionOf: (id) => {
          const p = info[id];
          if (!p) return 0;
          if (p.team && !gameDates[p.team]) return 0;
          return p.projection ?? 0;
        },
        kickedOff: (id) => pointsOf(id) > 0,
        unavailable: new Set([...(roster?.reserve ?? []), ...(roster?.taxi ?? [])].map(String)),
      });

      const players = entries.map(({ id, slot, index, replacement: fill }) => {
        const p = (id && info[id]) || {};
        const date = p.team ? gameDates[p.team] : null;
        return {
          id,
          slot,
          // Set in this slot right now, or filled in by the model.
          set: id != null && index != null,
          name: id ? p.name || String(id) : fill > 0 ? 'Waiver pickup' : 'Empty slot',
          position: p.position ?? slot,
          team: p.team,
          opponent: p.opponent,
          injury: p.injury,
          projection: id ? p.projection : fill > 0 ? fill : null,
          // Live points once games start; zero before kickoff.
          points: id ? pointsOf(id) : 0,
          day: date
            ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
                weekday: 'short',
                timeZone: 'UTC',
              })
            : null,
        };
      });

      return {
        rosterId,
        team: user?.metadata?.team_name || owner?.name || 'Unknown',
        manager: owner?.name ?? null,
        points: Number(m?.points ?? 0),
        projected:
          Math.round(players.reduce((sum, p) => sum + (p.projection ?? 0), 0) * 10) / 10,
        // How many slots the model had to fill in because they were not set.
        unset: players.filter((p) => p.id && !p.set).length,
        players,
      };
    };

    return NextResponse.json({ week, home: side(homeRoster), away: side(awayRoster) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
