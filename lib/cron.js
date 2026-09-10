import { readFileSync, existsSync } from 'node:fs';
import { h2hProbability, twoWayOdds } from './odds.js';
import { teamGameDates, lockTimeFor, lockInstantFor } from './schedule.js';
import { fieldOdds } from './odds.js';
import { resolveMarket } from './settle.js';
import { settleMarket } from './book.js';
import { SLEEPER_OWNERS } from './sleeper-owners.js';

/**
 * Market building and settling, callable from a serverless function.
 *
 * The CLI scripts do the same work, but they read the 15MB Sleeper player file
 * from disk and take `process.argv`. Neither survives a deploy, so the logic
 * lives here and the scripts stay as the manual escape hatch.
 */

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

const api = async (path) => {
  const r = await fetch(`https://api.sleeper.app/v1${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path} -> ${r.status}`);
  return r.json();
};

/**
 * Position and NFL team for the players on a roster.
 *
 * The full Sleeper player file is ~15MB and cannot ship in a serverless bundle,
 * so this reads the slim public/players.json the live view already uses and
 * falls back to fetching only what is missing.
 */
async function loadPlayerIndex() {
  const local = 'public/players.json';
  if (existsSync(local)) {
    try {
      const slim = JSON.parse(readFileSync(local, 'utf8'));
      // The slim file has name and position but not NFL team, which lock times
      // need. Fetch teams separately -- one small request, not fifteen megabytes.
      return slim;
    } catch {}
  }
  return {};
}

async function loadProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const byId = {};
  const teamById = {};
  for (const r of await res.json()) {
    if (!r.player_id) continue;
    if (typeof r?.stats?.pts_ppr === 'number') byId[r.player_id] = r.stats.pts_ppr;
    // The projections payload carries the player's team, which is all the lock
    // calculation needs -- no separate player file required.
    if (r?.player?.team) teamById[r.player_id] = r.player.team;
    else if (r?.team) teamById[r.player_id] = r.team;
  }
  return { projections: byId, teams: teamById };
}

const BASELINE = { QB: 16, RB: 10, WR: 9, TE: 7, K: 8, DEF: 7 };

/** Builds the week's markets. Existing markets are left untouched. */
export async function buildWeek(sql, season, week) {
  const [league, users, rosters, matchups] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
  ]);

  if (!matchups?.length) return { created: 0, skipped: 0, note: 'no matchups' };

  const [{ projections, teams: nflTeams }, gameDates, slim] = await Promise.all([
    loadProjections(season, week),
    teamGameDates(season, week),
    loadPlayerIndex(),
  ]);

  const latestGameDay = Object.values(gameDates).sort().pop();
  const fallbackLock = latestGameDay
    ? lockInstantFor(latestGameDay)
    : new Date(Date.now() + 86400e3);

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

  const positionOf = (id) => slim[id]?.p ?? '?';
  const nameOf = (id) => slim[id]?.n ?? String(id);
  const projectPlayer = (id) => projections[id] ?? BASELINE[positionOf(id)] ?? 7;
  const teamsOf = (m) =>
    (m.starters ?? []).filter((id) => id && id !== '0').map((id) => nflTeams[id]).filter(Boolean);
  const projectTeam = (m) =>
    Math.round(
      (m.starters ?? [])
        .filter((id) => id && id !== '0')
        .reduce((sum, id) => sum + projectPlayer(id), 0) * 10,
    ) / 10;

  const teamOf = (rosterId) => {
    const r = rosterById[rosterId];
    const owner = SLEEPER_OWNERS[r?.owner_id];
    if (!owner) return null;
    const u = userById[r.owner_id];
    return { slug: owner.slug, name: owner.name, team: u?.metadata?.team_name || owner.name };
  };

  let created = 0;
  let skipped = 0;

  async function createMarket({ kind, title, subtitle, meta, options, locksAt }) {
    const [existing] = await sql`
      select id from markets
      where season = ${season} and week = ${week} and kind = ${kind} and title = ${title}`;
    if (existing) {
      skipped++;
      return;
    }
    const [m] = await sql`
      insert into markets (season, week, kind, title, subtitle, locks_at, meta)
      values (${season}, ${week}, ${kind}, ${title}, ${subtitle}, ${locksAt},
              ${JSON.stringify(meta)}::jsonb)
      returning id`;
    for (const o of options) {
      await sql`
        insert into market_options (market_id, option_key, label, odds)
        values (${m.id}, ${o.key}, ${o.label}, ${o.odds})`;
    }
    created++;
  }

  const byMatchup = {};
  for (const m of matchups) (byMatchup[m.matchup_id] ??= []).push(m);

  for (const pair of Object.values(byMatchup)) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const home = teamOf(a.roster_id);
    const away = teamOf(b.roster_id);
    if (!home || !away) continue;

    const projHome = projectTeam(a);
    const projAway = projectTeam(b);
    const { home: oddsHome, away: oddsAway } = twoWayOdds(h2hProbability(projHome, projAway));
    const matchupLock = lockTimeFor([...teamsOf(a), ...teamsOf(b)], gameDates, fallbackLock);

    await createMarket({
      kind: 'h2h',
      title: `${home.team} vs ${away.team}`,
      subtitle: 'Who wins the matchup',
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        awaySlug: away.slug,
      },
      locksAt: matchupLock,
      options: [
        { key: 'home', label: home.team, odds: oddsHome },
        { key: 'away', label: away.team, odds: oddsAway },
      ],
    });

    const raw = Math.round((projHome - projAway) * 2) / 2;
    const spread = Number.isInteger(raw) ? raw + 0.5 : raw;
    const favourite = spread >= 0 ? home : away;
    const underdog = spread >= 0 ? away : home;
    const abs = Math.abs(spread);
    await createMarket({
      kind: 'spread',
      title: `${favourite.team} -${abs} vs ${underdog.team}`,
      subtitle: `Does ${favourite.team} win by more than ${abs}?`,
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        favouriteSlug: favourite.slug,
        underdogSlug: underdog.slug,
        spread: abs,
      },
      locksAt: matchupLock,
      options: [
        { key: 'cover', label: `${favourite.team} -${abs}`, odds: -110 },
        { key: 'nocover', label: `${underdog.team} +${abs}`, odds: -110 },
      ],
    });

    for (const [side, team, proj, rosterId, matchup] of [
      ['home', home, projHome, a.roster_id, a],
      ['away', away, projAway, b.roster_id, b],
    ]) {
      const line = Math.round(proj * 2) / 2 + 0.5;
      await createMarket({
        kind: 'total',
        title: `${team.team} over/under ${line}`,
        subtitle: `Does ${team.team} score more than ${line}?`,
        meta: { rosterId, slug: team.slug, line, side },
        locksAt: lockTimeFor(teamsOf(matchup), gameDates, fallbackLock),
        options: [
          { key: 'over', label: `Over ${line}`, odds: -110 },
          { key: 'under', label: `Under ${line}`, odds: -110 },
        ],
      });
    }
  }

  // A prop for every skill starter, so anyone can bet anyone on their roster.
  // Kickers and defences are skipped: their scoring is close to a coin flip, so
  // the line carries no information and nobody wants to bet it.
  const candidates = [];
  for (const m of matchups) {
    const team = teamOf(m.roster_id);
    if (!team) continue;
    for (const id of (m.starters ?? []).filter((x) => x && x !== '0')) {
      const pos = positionOf(id);
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
      candidates.push({
        playerId: id,
        name: nameOf(id),
        position: pos,
        rosterId: m.roster_id,
        slug: team.slug,
        team: team.team,
        nflTeam: nflTeams[id],
        projection: projectPlayer(id),
      });
    }
  }
  candidates.sort((x, y) => y.projection - x.projection);

  for (const p of candidates) {
    const line = Math.round(p.projection * 2) / 2 + 0.5;
    await createMarket({
      kind: 'prop',
      title: `${p.name} over/under ${line}`,
      subtitle: `${p.position} · started by ${p.team}`,
      meta: {
        playerId: p.playerId,
        playerName: p.name,
        position: p.position,
        rosterId: p.rosterId,
        slug: p.slug,
        line,
        nflTeam: p.nflTeam,
      },
      locksAt: lockTimeFor([p.nflTeam], gameDates, fallbackLock),
      options: [
        { key: 'over', label: `Over ${line}`, odds: -110 },
        { key: 'under', label: `Under ${line}`, odds: -110 },
      ],
    });
  }

  // League-wide "best in the league this week" markets. One market, one option
  // per manager -- unlike everything else on the board, these belong to no
  // matchup, which is why they get their own section rather than a game card.
  //
  // They are team bets: if your roster started the top RB, your option wins.
  const specials = [
    { key: 'team', title: 'Highest scoring team', subtitle: 'Most points in the league this week' },
    { key: 'RB', title: 'Highest scoring RB', subtitle: 'Best starting RB in the league' },
    { key: 'WR', title: 'Highest scoring WR', subtitle: 'Best starting WR in the league' },
    { key: 'TE', title: 'Highest scoring TE', subtitle: 'Best starting TE in the league' },
  ];

  for (const spec of specials) {
    // Weight each roster by what it is projected to bring to this question --
    // its whole lineup for the team market, its best starter at that position
    // otherwise. A roster with no starter at the position is left out entirely
    // rather than priced as a longshot it cannot win.
    const weights = {};
    const labels = {};
    for (const m of matchups) {
      const team = teamOf(m.roster_id);
      if (!team) continue;
      const starters = (m.starters ?? []).filter((x) => x && x !== '0');

      let weight;
      if (spec.key === 'team') {
        weight = projectTeam(m);
      } else {
        const atPosition = starters
          .filter((id) => positionOf(id) === spec.key)
          .map((id) => projectPlayer(id));
        if (!atPosition.length) continue;
        weight = Math.max(...atPosition);
      }
      if (!(weight > 0)) continue;
      weights[m.roster_id] = weight;
      labels[m.roster_id] = team.team;
    }

    const rosterIds = Object.keys(weights);
    // Needs a real field. Two managers is not a market worth pricing.
    if (rosterIds.length < 3) continue;

    const prices = fieldOdds(weights);
    await createMarket({
      kind: 'special',
      title: spec.title,
      subtitle: spec.subtitle,
      meta: {
        special: spec.key === 'team' ? 'team' : 'position',
        ...(spec.key === 'team' ? {} : { position: spec.key }),
      },
      // Every lineup in the league is involved, so this locks at the EARLIEST
      // kickoff of the week, not the latest. fallbackLock is the last game day
      // and would have left it bettable after the answer was half known.
      locksAt: lockTimeFor(Object.keys(gameDates), gameDates, fallbackLock),
      options: rosterIds.map((id) => ({
        key: String(id),
        label: labels[id],
        odds: prices[id],
      })),
    });
  }

  return { created, skipped };
}

/** Settles a week's markets from final scores. Already-settled markets are skipped. */
export async function settleWeek(sql, season, week) {
  const matchups = await api(`/league/${LEAGUE_ID}/matchups/${week}`);
  if (!matchups?.some((m) => m.points > 0)) {
    return { settled: 0, voided: 0, note: 'no scores' };
  }

  const pointsByRoster = {};
  const pointsByPlayer = {};
  const startedPlayers = new Set();
  // Which roster STARTED each player, and what he scored. League-wide "best RB
  // this week" markets settle off this: a player on a bench did not count for
  // his manager's score and must not win him the bet either.
  const starterRosters = {};
  for (const m of matchups) {
    pointsByRoster[m.roster_id] = Number(m.points ?? 0);
    for (const [pid, pts] of Object.entries(m.players_points ?? {})) {
      pointsByPlayer[pid] = Math.max(pointsByPlayer[pid] ?? 0, Number(pts ?? 0));
    }
    const points = m.starters_points ?? [];
    for (const [i, id] of (m.starters ?? []).entries()) {
      if (!id || id === '0') continue;
      startedPlayers.add(id);
      starterRosters[id] = { rosterId: m.roster_id, points: Number(points[i] ?? 0) };
    }
  }

  // Positions come from the slim player file the live view already uses.
  // Only special markets need them, so a missing file degrades to voiding
  // those rather than failing the whole settlement.
  let positionOf = () => '?';
  try {
    const slim = await loadPlayerIndex();
    positionOf = (id) => slim[id]?.p ?? '?';
  } catch {
    // Left as the stub; positional specials will void.
  }

  const markets = await sql`
    select id, kind, title, status, meta from markets
    where season = ${season} and week = ${week} and status not in ('settled', 'void')`;

  let settled = 0;
  let voided = 0;
  for (const m of markets) {
    const outcome = resolveMarket(m, {
      pointsByRoster,
      pointsByPlayer,
      startedPlayers,
      starterRosters,
      positionOf,
    });
    if (outcome == null) continue;
    await settleMarket(Number(m.id), outcome);
    if (outcome === 'void') voided++;
    else settled++;
  }

  return { settled, voided };
}
