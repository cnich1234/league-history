/**
 * Daily fantasy payouts must survive the trophy index.
 *
 * settleContest wrote placement points as reason 'trophies', and
 * point_ledger_trophies_once is unique on (bettor, season, week) for that
 * reason. Once the cron had granted somebody's trophy points for the week,
 * their daily fantasy payout conflicted, `on conflict do nothing` dropped it,
 * and `paid` reported it anyway. Nearly everyone earns some trophy points
 * every week, so nearly nobody was ever paid.
 *
 * Sentinel season, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { settleContest, PLACE_POINTS } from '../lib/dfs.js';

const sql = neon(process.env.DATABASE_URL);
const SEASON = 9998;
const WEEK = 1;

let failed = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed += 1;
};

const [a, b] = await sql`select slug from bettors order by slug limit 2`;

async function cleanup() {
  await sql`delete from point_ledger where season = ${SEASON}`;
  await sql`delete from dfs_entries where season = ${SEASON}`;
  await sql`delete from dfs_contests where season = ${SEASON}`;
}

try {
  await cleanup();

  // The week's trophy points have already been granted -- the state the cron
  // is in when it reaches daily fantasy.
  await sql`
    insert into point_ledger (bettor, season, week, amount, reason, note)
    values (${a.slug}, ${SEASON}, ${WEEK}, 17, 'trophies', 'Week 1 trophies')`;

  const [c] = await sql`
    insert into dfs_contests (season, week, kind, name, status)
    values (${SEASON}, ${WEEK}, 'weekly', 'Week 1', 'locked') returning id`;
  for (const [slug, slots] of [
    [a.slug, ['p1', 'p2']],
    [b.slug, ['p3', 'p4']],
  ]) {
    await sql`
      insert into dfs_entries (contest_id, season, week, bettor, slots, salary_used)
      values (${c.id}, ${SEASON}, ${WEEK}, ${slug}, ${JSON.stringify(slots)}::jsonb, 0)`;
  }

  console.log('\nsettling with trophy points already on the ledger');
  const res = await settleContest(Number(c.id), {
    points: { p1: 50, p2: 50, p3: 10, p4: 10 },
  });
  ok('two entries settled', res.settled === 2);

  const rows = await sql`
    select bettor, amount, reason from point_ledger
    where season = ${SEASON} and week = ${WEEK} order by bettor, reason`;
  const mine = rows.filter((r) => r.bettor === a.slug);
  ok('trophy row still there', mine.some((r) => r.reason === 'trophies' && r.amount === 17));
  ok(
    `winner's daily payout landed (${PLACE_POINTS[0]})`,
    mine.some((r) => r.reason === 'daily' && r.amount === PLACE_POINTS[0]),
  );
  ok(
    `runner-up paid ${PLACE_POINTS[1]}`,
    rows.some((r) => r.bettor === b.slug && r.reason === 'daily' && r.amount === PLACE_POINTS[1]),
  );

  const [bal] = await sql`
    select coalesce(sum(amount), 0)::int as pts from point_ledger
    where bettor = ${a.slug} and season = ${SEASON}`;
  ok(`balance is both together (${17 + PLACE_POINTS[0]})`, bal.pts === 17 + PLACE_POINTS[0]);

  console.log('\nsettling twice does not pay twice');
  const again = await settleContest(Number(c.id), { points: {} });
  ok('second settle is a no-op', again.settled === 0);
  const [n] = await sql`
    select count(*)::int as n from point_ledger where season = ${SEASON} and reason = 'daily'`;
  ok('still exactly two daily rows', n.n === 2);
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
