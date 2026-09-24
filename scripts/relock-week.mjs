/**
 * Recompute locks_at for a week's markets from real kickoff times, and reopen
 * anything that was locked early.
 *
 * Written for 2026-09-17, when the whole Thursday board closed at midnight for
 * a game that kicked off at 5:15 that afternoon. locks_at had been set from
 * lockInstantFor(gameDay) -- midnight Arizona -- so lockDueMarkets swept every
 * non-live market seventeen hours before a ball was thrown.
 *
 * Safe to re-run: it only ever moves a market's deadline to what the schedule
 * says, and only reopens one whose corrected deadline is still in the future.
 * A market with a settled bet on it is never touched.
 *
 *   node --env-file=.env.local scripts/relock-week.mjs [season] [week] [--apply]
 *
 * Without --apply it prints what it would do and changes nothing.
 */
import { neon } from '@neondatabase/serverless';
import { teamGameDates, lockTimeFor, latestKickoff } from '../lib/schedule.js';
import { SLEEPER_OWNERS } from '../lib/sleeper-owners.js';

const sql = neon(process.env.DATABASE_URL);
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

const season = Number(process.argv[2]) || Number(process.env.BOOK_SEASON) || 2026;
const week = Number(process.argv[3]) || 2;
const APPLY = process.argv.includes('--apply');

const api = (p) => fetch(`https://api.sleeper.app/v1${p}`).then((r) => r.json());

const [gameDates, rosters, matchups, players] = await Promise.all([
  teamGameDates(season, week),
  api(`/league/${LEAGUE_ID}/rosters`),
  api(`/league/${LEAGUE_ID}/matchups/${week}`),
  fetch('https://api.sleeper.app/v1/players/nfl').then((r) => r.json()),
]);

const fallback = latestKickoff(gameDates) ?? new Date(Date.now() + 86400e3);

// Which NFL teams a roster's STARTERS play for. The lock follows the lineup,
// not the whole roster: a benched Thursday player must not close a market.
// Kept per position too, so a QB showdown can close on its quarterbacks.
const teamsByRoster = {};
const teamsByRosterPos = {};
for (const m of matchups) {
  const starters = (m.starters ?? []).filter((id) => id && id !== '0');
  teamsByRoster[m.roster_id] = starters.map((id) => players[id]?.team).filter(Boolean);
  const byPos = {};
  for (const id of starters) {
    const p = players[id];
    if (!p?.team || !p?.position) continue;
    (byPos[p.position] ??= []).push(p.team);
  }
  teamsByRosterPos[m.roster_id] = byPos;
}
void rosters;
void SLEEPER_OWNERS;

/** The teams a market depends on, by kind. */
function teamsFor(kind, meta) {
  if (kind === 'prop') return meta?.nflTeam ? [meta.nflTeam] : [];
  if (kind === 'special') return Object.keys(gameDates); // every lineup is involved
  // A total belongs to ONE roster and carries rosterId; everything else
  // matchup-shaped carries both sides.
  const ids = [meta?.homeRoster, meta?.awayRoster, meta?.rosterId].filter((x) => x != null);
  // A positional showdown rides on that position alone; the FLEX battle on
  // every RB, WR and TE, since any of them might be the one left over.
  if (kind === 'showdown' && meta?.position) {
    const positions = meta.position === 'FLEX' ? ['RB', 'WR', 'TE'] : [meta.position];
    const teams = ids.flatMap((id) => positions.flatMap((pos) => teamsByRosterPos[id]?.[pos] ?? []));
    if (teams.length) return teams;
  }
  return ids.flatMap((id) => teamsByRoster[id] ?? []);
}

const rows = await sql`
  select id, kind, title, status, locks_at, live, meta
  from markets where season = ${season} and week = ${week}
  order by id`;

const now = new Date();
const changes = [];
for (const r of rows) {
  // For a LIVE market locks_at is not a deadline -- it is when live pricing
  // begins, and the board shows "Closed" between that instant and the first
  // real price. With the old midnight stamp that gap was most of a day on a
  // game that had not kicked off. The timestamp still wants to be kickoff; the
  // market simply never closes on it.
  const teams = teamsFor(r.kind, r.meta ?? {});
  if (!teams.length) continue;
  const want = lockTimeFor(teams, gameDates, fallback);
  if (!want) continue;
  const have = new Date(r.locks_at);
  const moved = Math.abs(want.getTime() - have.getTime()) > 60_000;
  const reopen = !r.live && r.status === 'locked' && want > now;
  if (moved || reopen) {
    changes.push({ id: r.id, kind: r.kind, title: r.title, have, want, status: r.status, reopen });
  }
}

console.log(`${season} week ${week}: ${rows.length} markets, ${changes.length} to correct`);
const hrs = (a, b) => ((b - a) / 3600000).toFixed(1);
for (const c of changes.slice(0, 50)) {
  console.log(
    `  ${c.reopen ? 'REOPEN' : 'move  '} ${String(c.kind).padEnd(9)} ` +
      `${c.have.toISOString()} -> ${c.want.toISOString()} (+${hrs(c.have, c.want)}h)  ${c.title.slice(0, 44)}`,
  );
}
if (changes.length > 50) console.log(`  ... and ${changes.length - 50} more`);

if (!APPLY) {
  console.log('\nDry run. Pass --apply to write.');
  process.exit(0);
}

let moved = 0;
let reopened = 0;
for (const c of changes) {
  // Never touch a market whose bets have already been settled: its deadline is
  // history at that point, and reopening it would invite a bet on a result.
  const [settled] = await sql`
    select 1 from bets where market_id = ${c.id} and status not in ('pending', 'void') limit 1`;
  if (settled) {
    console.log(`  skip ${c.id}: has settled bets`);
    continue;
  }
  await sql`update markets set locks_at = ${c.want} where id = ${c.id}`;
  moved++;
  if (c.reopen) {
    await sql`update markets set status = 'open' where id = ${c.id} and status = 'locked'`;
    reopened++;
  }
}
console.log(`\nmoved ${moved} deadline(s), reopened ${reopened} market(s)`);
