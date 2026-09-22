/**
 * The banked-profit standings, against a bettor whose real totals are known.
 *
 * getBanks summed the ledger and counted bets in one statement, joining both
 * tables to the same bettor. That multiplies them: every ledger row repeats
 * once per bet and every bet once per ledger row, so both aggregates came out
 * scaled by the other table's row count.
 *
 * Nothing looked broken. A bank of $234.92 across 13 ledger rows and 8 bets
 * displayed as $1,879.36 with a 39W/65L record -- a big number on a betting
 * page, which is the last place a big number looks wrong. Chris caught it by
 * knowing he had not won that much.
 *
 * The multiplier is each bettor's own row count, so the inflation differed per
 * person and the standings were in the wrong ORDER too. That is the part worth
 * guarding: a prize decided by this list went to whoever had bet most often.
 *
 * Sentinel bettors, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { getBanks } from '../lib/book.js';

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

const LOPSIDED = 'zz-test-lopsided';
const PLAIN = 'zz-test-plain';

async function clean() {
  for (const slug of [LOPSIDED, PLAIN]) {
    await sql`delete from ledger where bettor = ${slug}`;
    await sql`delete from bets where bettor = ${slug}`;
    await sql`delete from bettors where slug = ${slug}`;
  }
}

try {
  await clean();

  await sql`insert into bettors (slug, display_name) values (${LOPSIDED}, 'ZZ Lopsided')`;
  await sql`insert into bettors (slug, display_name) values (${PLAIN}, 'ZZ Plain')`;

  // Banked profit is the week-null ledger: $100 + $50 = $150. The week-keyed
  // rows are this week's spending money and must not count toward the bank.
  await sql`insert into ledger (bettor, amount_cents, reason, note) values (${LOPSIDED}, 10000, 'payout', 'Winnings banked')`;
  await sql`insert into ledger (bettor, amount_cents, reason, note) values (${LOPSIDED}, 5000, 'payout', 'Winnings banked')`;
  await sql`insert into ledger (bettor, amount_cents, reason, note, week) values (${LOPSIDED}, 50000, 'allowance', 'Week allowance', 901)`;
  await sql`insert into ledger (bettor, amount_cents, reason, note, week) values (${LOPSIDED}, -20000, 'stake', 'Bet placed', 901)`;

  // Five settled bets: 2 won, 3 lost. Deliberately a different count from the
  // four ledger rows, so a fan-out cannot coincidentally produce the truth.
  for (const st of ['won', 'won', 'lost', 'lost', 'lost']) {
    // Parlay-shaped: a straight bet needs a real market, and the record
    // counts both kinds the same way.
    await sql`insert into bets (bettor, market_id, option_key, stake_cents, odds, status, is_parlay)
              values (${LOPSIDED}, null, null, 1000, -110, ${st}, true)`;
  }

  // A bettor with ledger rows but no bets at all: the join that broke this
  // was a LEFT join, so his bank survived. Kept as the case that stayed right.
  await sql`insert into ledger (bettor, amount_cents, reason, note) values (${PLAIN}, 7700, 'payout', 'Winnings banked')`;

  const rows = await getBanks();
  const lop = rows.find((r) => r.slug === LOPSIDED);
  const plain = rows.find((r) => r.slug === PLAIN);

  console.log('\nthe bank is the ledger, not the ledger times the bets');
  ok('banked profit is the week-null sum', Number(lop.bank_cents), 15000);
  ok('a bettor with no bets still banks', Number(plain.bank_cents), 7700);

  console.log('\nthe record is the bets, not the bets times the ledger');
  ok('wins', lop.wins, 2);
  ok('losses', lop.losses, 3);
  ok('pending', lop.pending, 0);
  ok('no bets is an empty record', [plain.wins, plain.losses], [0, 0]);

  console.log('\nand the order is by real money');
  // $150 against $77. Under the old query the bettor with five bets was
  // multiplied by five and the one with none was not, which flipped these.
  const lopAt = rows.findIndex((r) => r.slug === LOPSIDED);
  const plainAt = rows.findIndex((r) => r.slug === PLAIN);
  ok('the richer bettor ranks higher', lopAt < plainAt, true);

  console.log('\nevery bettor agrees with a plain sum of their own ledger');
  // The real guard: whatever getBanks says, recount it one bettor at a time.
  let mismatched = [];
  for (const r of rows) {
    const [t] = await sql`
      select coalesce(sum(amount_cents) filter (where week is null), 0)::bigint as bank
      from ledger where bettor = ${r.slug}`;
    const [b] = await sql`
      select count(*) filter (where status = 'won')::int as w,
             count(*) filter (where status = 'lost')::int as l
      from bets where bettor = ${r.slug}`;
    if (Number(t.bank) !== Number(r.bank_cents) || b.w !== r.wins || b.l !== r.losses) {
      mismatched.push(r.slug);
    }
  }
  ok('nobody is inflated', mismatched, []);

  console.log(failed ? `\n${failed} FAILED` : '\nall good');
} finally {
  await clean();
}

process.exit(failed ? 1 : 0);
