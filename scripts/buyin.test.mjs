/**
 * Re-up rules. The point of these checks is that real money and play money
 * never contaminate each other: a re-up must restore a bankroll without making
 * the buyer look like they are winning the season.
 */
import { neon } from '@neondatabase/serverless';
import { recordBuyin, markBuyinCollected, getPrizePool, getBuyins, getBankrolls } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);
const SEASON = 9999;
const SLUG = 'chad-rissland';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`); failed++; }
};
const rejects = async (label, fn, fragment) => {
  try { await fn(); console.log(`  FAIL ${label} (expected rejection)`); failed++; }
  catch (e) {
    if (!fragment || e.message.toLowerCase().includes(fragment.toLowerCase())) console.log(`  ok   ${label}`);
    else { console.log(`  FAIL ${label}: ${e.message}`); failed++; }
  }
};
const balanceOf = async (slug) =>
  Number((await getBankrolls()).find((r) => r.slug === slug).balance_cents);

async function cleanup() {
  const ids = (await sql`select id from buyins where season = ${SEASON}`).map((r) => r.id);
  for (const id of ids) {
    await sql`delete from ledger where note like ${'Re-up #' + id + '%'}`;
  }
  await sql`delete from buyins where season = ${SEASON}`;
}

await cleanup();

try {
  console.log('\nre-up');
  const before = await balanceOf(SLUG);
  const buyin = await recordBuyin({ slug: SLUG, season: SEASON, note: 'went broke week 5' });
  check('real money owed is $20', Number(buyin.amount_cents), 2000);
  check('play money credited is $1000', Number(buyin.bankroll_cents), 100000);
  check('starts uncollected', buyin.collected, false);
  check('bankroll restored', (await balanceOf(SLUG)) - before, 100000);

  console.log('\nreal vs play money stay separate');
  const pool1 = await getPrizePool(SEASON);
  check('uncollected cash is not in the pot', pool1.collectedCents, 0);
  check('but it is tracked as outstanding', pool1.outstandingCents, 2000);
  check('pot is still just the base prize', pool1.totalCents, 20000);

  await markBuyinCollected(buyin.id);
  const pool2 = await getPrizePool(SEASON);
  check('collecting adds to the pot', pool2.collectedCents, 2000);
  check('pot grows past the base', pool2.totalCents, 22000);
  check('nothing outstanding now', pool2.outstandingCents, 0);

  console.log('\nmultiple re-ups');
  await recordBuyin({ slug: SLUG, season: SEASON });
  await recordBuyin({ slug: 'mike-brown', season: SEASON });
  const all = await getBuyins(SEASON);
  check('all three recorded', all.length, 3);
  const pool3 = await getPrizePool(SEASON);
  check('two still uncollected', pool3.buyinsOutstanding, 2);
  check('pot counts only collected', pool3.totalCents, 22000);
  check('outstanding is tracked separately', pool3.outstandingCents, 4000);

  console.log('\nvalidation');
  await rejects('rejects unknown bettor', () => recordBuyin({ slug: 'nobody', season: SEASON }), 'unknown bettor');
  await rejects('rejects fractional bankroll', () => recordBuyin({ slug: SLUG, season: SEASON, bankrollCents: 1.5 }), 'whole number');
  await rejects('rejects negative buy-in', () => recordBuyin({ slug: SLUG, season: SEASON, amountCents: -2000 }), 'positive');
  await rejects('rejects unknown buy-in id', () => markBuyinCollected(999999999), 'no such');
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from buyins where season = ${SEASON}`;
check('buyins removed', n, 0);
// Real league bets exist now, so a flat $1000 is no longer the invariant.
// What must hold is that every balance is explained by its own ledger.
const mismatched = await sql`
  select b.slug from bankrolls b
  join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
    on l.bettor = b.slug
  where b.balance_cents <> l.total
  order by b.slug`;
check('every balance equals its ledger', mismatched.map((r) => r.slug), []);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
