/**
 * Settles a week's markets from Sleeper's final scores.
 *
 * Every market kind is decided from the same matchup payload, so there is one
 * source of truth and no chance of a hand-entered result. Settlement is
 * idempotent -- an already-settled market is skipped, and the unique index on
 * (bet_id, reason) makes a double payout a database error rather than a silent
 * doubling of someone's bankroll.
 *
 * Usage:
 *   node --env-file=.env.local scripts/settle-week.mjs <week> [--dry]
 *
 * --dry prints what would happen and writes nothing. Worth using the first time
 * every season, because a wrong settlement is far more annoying to unwind than
 * to prevent.
 */
import { neon } from '@neondatabase/serverless';
import { settleMarket } from '../lib/book.js';
import { resolveMarket } from '../lib/settle.js';

const sql = neon(process.env.DATABASE_URL);
const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

const week = Number(process.argv[2]);
const dry = process.argv.includes('--dry');
if (!week) {
  console.error('Usage: node --env-file=.env.local scripts/settle-week.mjs <week> [--dry]');
  process.exit(1);
}

const api = async (p) => {
  const r = await fetch(`https://api.sleeper.app/v1${p}`);
  if (!r.ok) throw new Error(`Sleeper ${p} -> ${r.status}`);
  return r.json();
};

const [state, matchups] = await Promise.all([
  api('/state/nfl'),
  api(`/league/${LEAGUE_ID}/matchups/${week}`),
]);
const season = Number(state.season);

if (!matchups.some((m) => m.points > 0)) {
  console.error(`Week ${week} has no scores yet. Nothing to settle.`);
  process.exit(1);
}

// Points by roster, and by player, are all any market needs to resolve.
const pointsByRoster = {};
const pointsByPlayer = {};
for (const m of matchups) {
  pointsByRoster[m.roster_id] = Number(m.points ?? 0);
  for (const [pid, pts] of Object.entries(m.players_points ?? {})) {
    // A player can only appear on one roster, but take the max defensively so
    // a duplicate cannot zero out a real score.
    pointsByPlayer[pid] = Math.max(pointsByPlayer[pid] ?? 0, Number(pts ?? 0));
  }
}

/** Which starters actually played, so a benched player's prop can be voided. */
const startedPlayers = new Set();
for (const m of matchups) {
  for (const id of m.starters ?? []) if (id && id !== '0') startedPlayers.add(id);
}

const markets = await sql`
  select id, kind, title, status, meta
  from markets
  where season = ${season} and week = ${week}
  order by kind, id`;

if (!markets.length) {
  console.error(`No markets for week ${week}.`);
  process.exit(1);
}

let settled = 0;
let skipped = 0;
let voided = 0;
let totalPaid = 0;

for (const m of markets) {
  if (m.status === 'settled' || m.status === 'void') {
    skipped++;
    continue;
  }

  const outcome = resolveMarket(m, { pointsByRoster, pointsByPlayer, startedPlayers });
  if (outcome == null) {
    console.log(`  ?  ${m.kind.padEnd(7)} ${m.title} — unknown kind, left alone`);
    skipped++;
    continue;
  }

  const [{ n }] = await sql`
    select count(*)::int as n from bets where market_id = ${m.id} and status = 'pending'`;

  const label = outcome === 'void' ? 'VOID' : outcome === 'push' ? 'PUSH' : outcome;
  const line = `  ${outcome === 'void' ? '~' : '+'}  ${m.kind.padEnd(7)} ${m.title}`;

  if (dry) {
    console.log(`${line} -> ${label} (${n} bet${n === 1 ? '' : 's'})`);
    if (outcome === 'void') voided++;
    else settled++;
    continue;
  }

  const result = await settleMarket(Number(m.id), outcome);
  totalPaid += result.paidCents;
  console.log(
    `${line} -> ${label} (${result.settled} bet${result.settled === 1 ? '' : 's'}` +
      `${result.paidCents ? `, $${(result.paidCents / 100).toFixed(2)} paid` : ''})`,
  );
  if (outcome === 'void') voided++;
  else settled++;
}

console.log(
  `\nWeek ${week}: ${settled} settled, ${voided} voided, ${skipped} skipped` +
    (dry ? '  (DRY RUN — nothing written)' : `, $${(totalPaid / 100).toFixed(2)} paid out`),
);

if (!dry) {
  console.log('\nBankrolls:');
  for (const r of await sql`select slug, balance_cents, wins, losses from bankrolls order by balance_cents desc`) {
    console.log(
      `  ${r.slug.padEnd(20)} $${(Number(r.balance_cents) / 100).toFixed(2).padStart(9)}` +
        `   ${r.wins}-${r.losses}`,
    );
  }
}
