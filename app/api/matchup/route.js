import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { neon } from '@neondatabase/serverless';
import { teamGameDates } from '@/lib/schedule';
import { SLEEPER_OWNERS } from '@/lib/sleeper-owners';

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
    const [state, users, rosters, matchups] = await Promise.all([
      fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`).then((r) => r.json()),
      fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${week}`).then((r) => r.json()),
    ]);
    const season = Number(state.season);

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

    const side = (rosterId) => {
      const roster = rosterById[rosterId];
      const owner = SLEEPER_OWNERS[roster?.owner_id];
      const user = userById[roster?.owner_id];
      const m = matchups.find((x) => x.roster_id === rosterId);
      const starters = (m?.starters ?? []).filter((id) => id && id !== '0');

      const players = starters.map((id, i) => {
        const p = info[id] ?? {};
        const date = p.team ? gameDates[p.team] : null;
        return {
          id,
          name: p.name || 'Empty slot',
          position: p.position ?? '?',
          team: p.team,
          opponent: p.opponent,
          injury: p.injury,
          projection: p.projection,
          // Live points once games start; zero before kickoff.
          points: Number(m?.starters_points?.[i] ?? 0),
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
        players,
      };
    };

    return NextResponse.json({ week, home: side(homeRoster), away: side(awayRoster) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
