/**
 * The results page, which a parlay took down.
 *
 * settledBets reads `week` from the market, and a parlay has no market -- it
 * has legs, which can span several weeks. So every parlay came back with a
 * null week. The page grouped by week with a plain object, and the failure
 * ran through three steps that are each individually reasonable:
 *
 *   byWeek[null]          -> the bucket is keyed by the STRING "null"
 *   Object.keys(byWeek)   -> ["2", "null"]
 *   ["2","null"].map(Number) -> [2, NaN]
 *   byWeek[NaN]           -> undefined
 *   byWeek[NaN].length    -> throws, and the whole page 500s
 *
 * 27 of 41 settled bets were parlays, so the page was dead for everyone.
 *
 * Two fixes, and this pins both: a parlay reports the week its STAKE came from
 * (which is what the ledger records and where a refund goes), and the grouping
 * drops a row it cannot place instead of crashing on it.
 */
import { neon } from '@neondatabase/serverless';
import { settledBets } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

/** The page's grouping, lifted verbatim from app/book/results/page.js. */
function groupByWeek(bets) {
  const byWeek = new Map();
  for (const b of bets) {
    // Number(null) is 0, not NaN, so null has to be rejected before the
    // cast -- otherwise an unweeked bet files itself under "Week 0".
    if (b.week == null) continue;
    const week = Number(b.week);
    if (!Number.isFinite(week)) continue;
    if (!byWeek.has(week)) byWeek.set(week, []);
    byWeek.get(week).push(b);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => b - a);
  // What the JSX then does to each bucket. This is the line that threw.
  return weeks.map((w) => ({ week: w, count: byWeek.get(w).length }));
}

console.log('\nthe grouping survives a row with no week');
{
  // The exact shape that crashed: a real week alongside an unweeked bet.
  const mixed = [{ week: 2 }, { week: null }, { week: 2 }];
  ok('an unplaceable row does not throw', groupByWeek(mixed), [{ week: 2, count: 2 }]);
  ok('a null-only list is empty, not NaN', groupByWeek([{ week: null }]), []);
  ok('undefined is handled too', groupByWeek([{ week: undefined }]), []);
  ok('a string week still groups', groupByWeek([{ week: '3' }]), [{ week: 3, count: 1 }]);
  ok('newest week first', groupByWeek([{ week: 2 }, { week: 5 }, { week: 3 }]).map((g) => g.week), [5, 3, 2]);
}

console.log('\nthe old grouping is what blew up');
{
  // Kept as the record of the bug: the same input, grouped the old way.
  const bets = [{ week: 2 }, { week: null }];
  const byWeek = {};
  for (const b of bets) (byWeek[b.week] ??= []).push(b);
  const weeks = Object.keys(byWeek).map(Number).sort((a, b) => b - a);
  ok('Object.keys stringifies null into a bucket', Object.keys(byWeek).includes('null'), true);
  ok('which Number turns into NaN', weeks.some((w) => Number.isNaN(w)), true);
  let threw = false;
  try {
    for (const w of weeks) byWeek[w].length;
  } catch {
    threw = true;
  }
  ok('and reading the bucket throws', threw, true);
}

console.log('\nevery settled bet in the real season carries a week');
{
  const bets = await settledBets(2026);
  const unweeked = bets.filter((b) => !Number.isFinite(Number(b.week)));
  ok('no settled bet is unplaceable', unweeked.length, 0);

  const parlays = bets.filter((b) => b.is_parlay);
  ok('there are parlays to check', parlays.length > 0, true);
  ok('every parlay has a week', parlays.filter((p) => !Number.isFinite(Number(p.week))).length, 0);

  // A parlay's week must be the week its stake actually came out of, not a
  // guess from its legs -- that is where a refunded stake is paid back.
  let wrong = [];
  for (const p of parlays) {
    const [row] = await sql`
      select week from ledger
      where bet_id = ${p.id} and reason = 'stake' and week is not null limit 1`;
    if (row && Number(row.week) !== Number(p.week)) wrong.push(p.id);
  }
  ok('and it matches the week its stake was taken from', wrong, []);

  // The real page, grouped for real. Nothing here may throw.
  const groups = groupByWeek(bets);
  ok('every bet lands in a bucket', groups.reduce((n, g) => n + g.count, 0), bets.length);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
