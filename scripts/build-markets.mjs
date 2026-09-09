/**
 * Creates the week's betting markets from Sleeper data.
 *
 * Lines are derived from Sleeper's own projections, so nobody has to set them
 * by hand and nobody can argue the commissioner shaded a number. Re-running a
 * week is safe: existing markets are left alone rather than duplicated, since
 * odds must not move after someone has bet.
 *
 * Usage: node --env-file=.env.local scripts/build-markets.mjs <week> [--lock "2026-09-14T17:00:00Z"]
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { SLEEPER_OWNERS } from './sleeper-owners.mjs';
import { h2hProbability, twoWayOdds, probabilityToOdds } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
const PLAYERS = 'C:/Users/chris/fantasy/draft-tool/data/sleeper-players.json';

const api = async (p) => {
  const r = await fetch(`https://api.sleeper.app/v1${p}`);
  if (!r.ok) throw new Error(`Sleeper ${p} -> ${r.status}`);
  return r.json();
};

const week = Number(process.argv[2]);
if (!week) {
  console.error('Usage: node --env-file=.env.local scripts/build-markets.mjs <week> [--lock <iso>]');
  process.exit(1);
}

const lockFlag = process.argv.indexOf('--lock');
// Default lock is the coming Sunday at 1pm ET, when the early games start.
const locksAt = lockFlag > -1 ? new Date(process.argv[lockFlag + 1]) : nextSundayKickoff();
if (Number.isNaN(locksAt.getTime())) throw new Error('Could not parse --lock as a date.');

function nextSundayKickoff() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(17, 0, 0, 0); // 1pm ET
  return d;
}

const [state, users, rosters, matchups] = await Promise.all([
  api('/state/nfl'),
  api(`/league/${LEAGUE_ID}/users`),
  api(`/league/${LEAGUE_ID}/rosters`),
  api(`/league/${LEAGUE_ID}/matchups/${week}`),
]);

/**
 * Real per-player projections, from the undocumented endpoint Sleeper's own web
 * app uses. Worth the dependency: a flat per-position estimate made every team
 * project identically, so every game priced as a coin flip and every total came
 * out at the same number -- a board with no information in it.
 *
 * Only ~400 of 3100 players carry a pts_ppr value, so anyone missing falls back
 * to a positional baseline rather than dropping out of their lineup.
 */
async function loadProjections(season, week) {
  const url = `https://api.sleeper.com/projections/nfl/${season}/${week}`
    + `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`
    + `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const rows = await res.json();
  const byId = {};
  for (const r of rows) {
    const pts = r?.stats?.pts_ppr;
    if (r.player_id && typeof pts === 'number') byId[r.player_id] = pts;
  }
  return byId;
}
const season = Number(state.season);
const players = JSON.parse(readFileSync(PLAYERS, 'utf8'));
const projections = await loadProjections(season, week);
console.log(`Loaded ${Object.keys(projections).length} player projections.`);

/** Positional fallback for a player Sleeper has no projection for. */
const BASELINE = { QB: 16, RB: 10, WR: 9, TE: 7, K: 8, DEF: 7 };
const projectPlayer = (id) => {
  if (projections[id] != null) return projections[id];
  return BASELINE[players[id]?.position] ?? 7;
};

const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

const teamOf = (rosterId) => {
  const r = rosterById[rosterId];
  const owner = SLEEPER_OWNERS[r?.owner_id];
  if (!owner) return null;
  const u = userById[r.owner_id];
  return { slug: owner.slug, name: owner.name, team: u?.metadata?.team_name || owner.name };
};

/** Projected total for a lineup: the sum of its starters' projections. */
function projectTeam(matchup) {
  const starters = (matchup.starters ?? []).filter((id) => id && id !== '0');
  const total = starters.reduce((sum, id) => sum + projectPlayer(id), 0);
  return Math.round(total * 10) / 10;
}

const byMatchup = {};
for (const m of matchups) (byMatchup[m.matchup_id] ??= []).push(m);

let created = 0;
let skipped = 0;

async function createMarket({ kind, title, subtitle, meta, options }) {
  const [existing] = await sql`
    select id from markets
    where season = ${season} and week = ${week} and kind = ${kind} and title = ${title}`;
  if (existing) {
    skipped++;
    return null;
  }
  const [m] = await sql`
    insert into markets (season, week, kind, title, subtitle, locks_at, meta)
    values (${season}, ${week}, ${kind}, ${title}, ${subtitle}, ${locksAt}, ${JSON.stringify(meta)}::jsonb)
    returning id`;
  for (const o of options) {
    await sql`
      insert into market_options (market_id, option_key, label, odds)
      values (${m.id}, ${o.key}, ${o.label}, ${o.odds})`;
  }
  created++;
  console.log(`  + ${kind.padEnd(7)} ${title}`);
  for (const o of options) console.log(`      ${o.key.padEnd(6)} ${o.label} @ ${o.odds > 0 ? '+' : ''}${o.odds}`);
  return m.id;
}

for (const pair of Object.values(byMatchup)) {
  if (pair.length !== 2) continue;
  const [a, b] = pair;
  const home = teamOf(a.roster_id);
  const away = teamOf(b.roster_id);
  if (!home || !away) continue;

  const projHome = projectTeam(a);
  const projAway = projectTeam(b);
  const pHome = h2hProbability(projHome, projAway);
  const { home: oddsHome, away: oddsAway } = twoWayOdds(pHome);

  // 1. Head to head
  await createMarket({
    kind: 'h2h',
    title: `${home.team} vs ${away.team}`,
    subtitle: 'Who wins the matchup',
    meta: { homeRoster: a.roster_id, awayRoster: b.roster_id, homeSlug: home.slug, awaySlug: away.slug },
    options: [
      { key: 'home', label: home.team, odds: oddsHome },
      { key: 'away', label: away.team, odds: oddsAway },
    ],
  });

  // 2. Spread. Half-point line so a push is impossible.
  const rawSpread = Math.round((projHome - projAway) * 2) / 2;
  const spread = Number.isInteger(rawSpread) ? rawSpread + 0.5 : rawSpread;
  const favourite = spread >= 0 ? home : away;
  const underdog = spread >= 0 ? away : home;
  const absSpread = Math.abs(spread);
  await createMarket({
    kind: 'spread',
    title: `${favourite.team} -${absSpread} vs ${underdog.team}`,
    subtitle: `Does ${favourite.team} win by more than ${absSpread}?`,
    meta: {
      homeRoster: a.roster_id, awayRoster: b.roster_id,
      favouriteSlug: favourite.slug, underdogSlug: underdog.slug, spread: absSpread,
    },
    options: [
      { key: 'cover', label: `${favourite.team} -${absSpread}`, odds: -110 },
      { key: 'nocover', label: `${underdog.team} +${absSpread}`, odds: -110 },
    ],
  });

  // 3. Team total. Over/under on one side's score.
  for (const [side, team, proj, rosterId] of [
    ['home', home, projHome, a.roster_id],
    ['away', away, projAway, b.roster_id],
  ]) {
    const line = Math.round(proj * 2) / 2 + 0.5;
    await createMarket({
      kind: 'total',
      title: `${team.team} over/under ${line}`,
      subtitle: `Does ${team.team} score more than ${line}?`,
      meta: { rosterId, slug: team.slug, line, side },
      options: [
        { key: 'over', label: `Over ${line}`, odds: -110 },
        { key: 'under', label: `Under ${line}`, odds: -110 },
      ],
    });
  }
}

// 4. Player props on the highest-projected starters, so the names are ones
//    people actually recognise. Two per matchup keeps the board readable.
const propCandidates = [];
for (const m of matchups) {
  const team = teamOf(m.roster_id);
  if (!team) continue;
  for (const id of (m.starters ?? []).filter((x) => x && x !== '0')) {
    const p = players[id];
    if (!p || !['QB', 'RB', 'WR', 'TE'].includes(p.position)) continue;
    propCandidates.push({
      playerId: id,
      name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
      position: p.position,
      rosterId: m.roster_id,
      slug: team.slug,
      team: team.team,
      projection: projectPlayer(id),
    });
  }
}

propCandidates.sort((x, y) => y.projection - x.projection);
for (const prop of propCandidates.slice(0, 10)) {
  // Half-point line so a prop can never push.
  const line = Math.round(prop.projection * 2) / 2 + 0.5;
  await createMarket({
    kind: 'prop',
    title: `${prop.name} over/under ${line}`,
    subtitle: `${prop.position} · started by ${prop.team}`,
    meta: { playerId: prop.playerId, playerName: prop.name, position: prop.position,
            rosterId: prop.rosterId, slug: prop.slug, line },
    options: [
      { key: 'over', label: `Over ${line}`, odds: -110 },
      { key: 'under', label: `Under ${line}`, odds: -110 },
    ],
  });
}

console.log(`\nWeek ${week}: ${created} market(s) created, ${skipped} already existed.`);
console.log(`Locks at ${locksAt.toISOString()}`);
