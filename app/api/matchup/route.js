import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { neon } from '@neondatabase/serverless';
import { teamGameDates } from '@/lib/schedule';
import { SLEEPER_OWNERS } from '@/lib/sleeper-owners';
import {
  expectedLineup,
  replacementTable,
  isRisky,
  startingSlotsOf,
  DEFAULT_SLOTS,
} from '@/lib/lineup';

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
      // Everyone the manager actually started, regardless of which slot.
      const startedIds = new Set(setStarters.filter(Boolean));
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
        doubtful: (id) => isRisky(info[id]?.injury),
      });

      const startingSlots = startingSlotsOf(slots);

      // THE ROWS ARE THE ACTUAL LINEUP. Whoever the manager started is who
      // shows, in the slot he put him in -- because that is who takes the
      // field, and a QB-versus-QB bet is settled on the man who plays, not on
      // the man the pricing model would have picked.
      //
      // Where the model prices somebody else, that is carried alongside as
      // `pricedAs` rather than replacing the row. Showing only the model's pick
      // meant Mahomes appeared as Ernie's quarterback while Caleb Williams was
      // the one actually starting, which is worse than unhelpful on a bet about
      // quarterbacks.
      const modelIds = new Set(entries.map((e) => e.id).filter(Boolean));
      const describe = (id) => {
        const p = (id && info[id]) || {};
        const date = p.team ? gameDates[p.team]?.date ?? null : null;
        return {
          id,
          name: id ? p.name || String(id) : null,
          position: p.position ?? null,
          team: p.team ?? null,
          opponent: p.opponent ?? null,
          injury: p.injury ?? null,
          projection: id ? (p.projection ?? null) : null,
          day: date
            ? new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
                weekday: 'short',
                timeZone: 'UTC',
              })
            : null,
        };
      };

      const players = startingSlots.map((slot, i) => {
        const startedId = setStarters[i];
        const entry = entries[i] ?? {};
        const modelId = entry.id ?? null;
        const fill = Number(entry.replacement) || 0;
        const base = describe(startedId);

        // The slot is empty and the model could not fill it either: it is worth
        // a waiver pickup and nothing more.
        if (!startedId && !modelId) {
          return {
            ...base,
            slot,
            name: fill > 0 ? 'Waiver pickup' : 'Empty slot',
            position: slot,
            projection: fill > 0 ? fill : null,
            points: 0,
            started: false,
            pricedAs: null,
          };
        }

        return {
          ...base,
          slot,
          // Nobody set here, but the model found somebody: the row IS the
          // model's pick, flagged as not started.
          ...(startedId ? {} : { ...describe(modelId), slot }),
          position: (startedId ? base.position : describe(modelId).position) ?? slot,
          points: startedId ? pointsOf(startedId) : 0,
          started: Boolean(startedId),
          // Set here, but the pricing model uses a different man. Named so the
          // manager can see exactly what the odds are built on.
          pricedAs:
            startedId && !modelIds.has(String(startedId)) && modelId
              ? describe(modelId)
              : null,
        };
      });

      // TWO TOTALS, because there are genuinely two numbers.
      //
      // `projected` is what the ODDS are built on: the best lineup this roster
      // could field, which is the anti-tanking rule. `asSet` is what the lineup
      // on screen actually adds up to. They differ exactly when the model
      // prices somebody the manager did not start, and the difference is the
      // edge he is giving away by not starting his best available side.
      const priced = entries.reduce(
        (sum, e) => sum + (e.id ? info[e.id]?.projection ?? 0 : Number(e.replacement) || 0),
        0,
      );
      const asSet = players.reduce((sum, p) => sum + (p.projection ?? 0), 0);

      return {
        rosterId,
        team: user?.metadata?.team_name || owner?.name || 'Unknown',
        manager: owner?.name ?? null,
        points: Number(m?.points ?? 0),
        projected: Math.round(priced * 10) / 10,
        asSet: Math.round(asSet * 10) / 10,
        // Slots where the odds are built on somebody other than the man set.
        unset: players.filter((p) => p.pricedAs).length,
        // Slots nobody is set in at all.
        empty: players.filter((p) => !p.started).length,
        players,
      };
    };

    return NextResponse.json({ week, home: side(homeRoster), away: side(awayRoster) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
