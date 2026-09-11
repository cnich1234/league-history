/**
 * Adds the missing bench props to a week that was built before props covered
 * whole rosters.
 *
 * Why not just re-run buildWeek: it would also recreate every spread, total and
 * showdown whose LINE has moved since the week was built. Those are skipped by
 * title match, and a moved line is a different title -- so week 2 would end up
 * with two versions of the same market at different prices. This touches props
 * and nothing else.
 *
 * Idempotent twice over: it skips any player who already has a prop this week,
 * and createMarket's own title check is still there underneath. Existing props
 * are never modified, so bets already placed on them are untouched.
 *
 *   node --env-file=.env.local scripts/backfill-props.mjs <week> [--apply]
 *
 * Without --apply it reports what it would do and writes nothing.
 */
import { neon } from '@neondatabase/serverless';
import { teamGameDates, lockTimeFor } from '../lib/schedule.js';

const sql = neon(process.env.DATABASE_URL);
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
const PLAYERS = 'C:/Users/chris/fantasy/draft-tool/data/sleeper-players.json';

/** Mirrors lib/cron.js. Below this a line is a bet on whether somebody dressed. */
const PROP_FLOOR = 3;
const BASELINE = { QB: 16, RB: 10, WR: 9, TE: 7, K: 8, DEF: 7 };
const SKILL = ['QB', 'RB', 'WR', 'TE'];

const week = Number(process.argv[2]);
const apply = process.argv.includes('--apply');
if (!Number.isInteger(week) || week < 1) {
  console.error('Usage: node scripts/backfill-props.mjs <week> [--apply]');
  process.exit(1);
}

const api = async (p) => {
  const r = await fetch(`https://api.sleeper.app/v1${p}`);
  if (!r.ok) throw new Error(`Sleeper ${p} -> ${r.status}`);
  return r.json();
};

const [league, users, rosters, matchups] = await Promise.all([
  api(`/league/${LEAGUE_ID}`),
  api(`/league/${LEAGUE_ID}/users`),
  api(`/league/${LEAGUE_ID}/rosters`),
  api(`/league/${LEAGUE_ID}/matchups/${week}`),
]);
const season = Number(league.season);
if (!matchups?.length) {
  console.log(`No matchups for week ${week}.`);
  process.exit(0);
}

const { readFileSync } = await import('node:fs');
const players = JSON.parse(readFileSync(PLAYERS, 'utf8'));

// Projections, same source and shape the builder uses.
const projRes = await fetch(
  `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular`,
);
const projRows = projRes.ok ? await projRes.json() : [];
const projections = {};
for (const r of projRows) {
  if (r?.player_id) {
    projections[r.player_id] = Number(r.stats?.pts_half_ppr ?? r.stats?.pts_ppr ?? 0);
  }
}

const gameDates = await teamGameDates(season, week);
const positionOf = (id) => players[id]?.position ?? null;
const nflTeamOf = (id) => players[id]?.team ?? null;
const nameOf = (id) =>
  `${players[id]?.first_name ?? ''} ${players[id]?.last_name ?? ''}`.trim();

// A rostered player whose NFL team has no game this week is on a bye.
const projectPlayer = (id) => {
  const team = nflTeamOf(id);
  if (team && !gameDates[team]) return 0;
  return projections[id] ?? BASELINE[positionOf(id)] ?? 7;
};

// Owners, so a prop can say whose bench it is on. Same module the builder
// uses -- league.json has no sleeperOwners key.
const { SLEEPER_OWNERS } = await import('../lib/sleeper-owners.js');
const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));
const teamOf = (rosterId) => {
  const r = rosterById[rosterId];
  const owner = SLEEPER_OWNERS[r?.owner_id];
  if (!owner) return null;
  const u = userById[r.owner_id];
  return { slug: owner.slug, team: u?.metadata?.team_name || owner.name };
};

// Whoever already has a prop this week is left completely alone -- title,
// line, odds and any bets on it.
const existing = await sql`
  select meta->>'playerId' as pid, title from markets
  where season = ${season} and week = ${week} and kind = 'prop'`;
const have = new Set(existing.map((r) => r.pid).filter(Boolean));
console.log(`Week ${week}: ${existing.length} prop(s) already exist.`);

const fallbackLock = new Date(
  Math.min(...Object.values(gameDates).map((d) => new Date(d).getTime())),
);

const toCreate = [];
let skippedHave = 0;
let skippedFloor = 0;
for (const m of matchups) {
  const team = teamOf(m.roster_id);
  if (!team) continue;
  const starting = new Set((m.starters ?? []).filter((x) => x && x !== '0'));
  for (const id of (m.players ?? []).filter((x) => x && x !== '0')) {
    const pos = positionOf(id);
    if (!SKILL.includes(pos)) continue;
    if (have.has(String(id))) {
      skippedHave++;
      continue;
    }
    const projection = projectPlayer(id);
    if (projection < PROP_FLOOR) {
      skippedFloor++;
      continue;
    }
    toCreate.push({
      playerId: String(id),
      name: nameOf(id),
      position: pos,
      rosterId: m.roster_id,
      slug: team.slug,
      team: team.team,
      nflTeam: nflTeamOf(id),
      projection,
      benched: !starting.has(id),
    });
  }
}
toCreate.sort((a, b) => b.projection - a.projection);

console.log(
  `  already have a prop: ${skippedHave}\n` +
    `  under the floor:     ${skippedFloor}\n` +
    `  to create:           ${toCreate.length} ` +
    `(${toCreate.filter((p) => p.benched).length} bench, ` +
    `${toCreate.filter((p) => !p.benched).length} starter)`,
);

if (!apply) {
  console.log('\nDry run. Sample:');
  for (const p of toCreate.slice(0, 10)) {
    const line = Math.round(p.projection * 2) / 2 + 0.5;
    console.log(
      `  ${p.name} o/u ${line}  [${p.position} · ${p.benched ? 'benched' : 'started'} by ${p.team}]`,
    );
  }
  console.log('\nRe-run with --apply to write.');
  process.exit(0);
}

let created = 0;
for (const p of toCreate) {
  const line = Math.round(p.projection * 2) / 2 + 0.5;
  const title = `${p.name} over/under ${line}`;
  // Second guard: the builder's own rule, in case a title collides anyway.
  const [clash] = await sql`
    select id from markets
    where season = ${season} and week = ${week} and kind = 'prop' and title = ${title}`;
  if (clash) continue;

  const [m] = await sql`
    insert into markets (season, week, kind, title, subtitle, locks_at, live, meta)
    values (${season}, ${week}, 'prop', ${title},
            ${`${p.position} · ${p.benched ? 'benched by' : 'started by'} ${p.team}`},
            ${lockTimeFor([p.nflTeam], gameDates, fallbackLock)},
            false,
            ${JSON.stringify({
              playerId: p.playerId,
              playerName: p.name,
              position: p.position,
              rosterId: p.rosterId,
              slug: p.slug,
              line,
              nflTeam: p.nflTeam,
              benched: p.benched,
            })}::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'over', ${`Over ${line}`}, -110),
           (${m.id}, 'under', ${`Under ${line}`}, -110)`;
  created++;
}
console.log(`\nCreated ${created} prop market(s) for week ${week}.`);
