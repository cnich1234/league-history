/**
 * Settlement, against a hand-built week whose correct answers are known.
 *
 * Week 1 has not been played, so there are no real scores to settle. Without
 * this, the first time settlement ran for real would be the first time anyone
 * checked whether it pays the right people -- and a wrong payout is far harder
 * to unwind than to prevent.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, settleMarket, getBankrolls } from '../lib/book.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9998;
// Own week, not week 1: week 1 is real and has real money in it.
const TEST_WEEK = testWeek(TEST_SEASON);

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`);
    failed++;
  }
};

const A = 'chris-nicholson';
const B = 'chad-rissland';
const balanceOf = async (slug) =>
  Number((await getBankrolls()).find((r) => r.slug === slug).balance_cents);

async function makeMarket(kind, options, meta = {}) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, meta)
    values (${TEST_SEASON}, ${TEST_WEEK}, ${kind}, ${kind + ' ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, ${JSON.stringify(meta)}::jsonb)
    returning id`;
  for (const [key, odds] of Object.entries(options)) {
    await sql`insert into market_options (market_id, option_key, label, odds)
              values (${m.id}, ${key}, ${key}, ${odds})`;
  }
  return Number(m.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  if (ids.length) {
    await sql`delete from ledger where bet_id in (select id from bets where market_id = any(${ids}))`;
    await sql`delete from bets where market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await unfundWeek(TEST_WEEK);
}

await cleanup();
await fundWeek(TEST_WEEK);

try {
  console.log('\nwinners and losers');
  const m1 = await makeMarket('h2h', { home: -150, away: 130 });
  await placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 5000 });
  await placeBet({ slug: B, marketId: m1, optionKey: 'away', stakeCents: 5000 });
  const aBefore = await balanceOf(A);
  const bBefore = await balanceOf(B);
  const r1 = await settleMarket(m1, 'home');
  check('both bets settled', r1.settled, 2);
  check('winner paid stake plus profit', (await balanceOf(A)) - aBefore, payoutCents(5000, -150));
  check('loser paid nothing', (await balanceOf(B)) - bBefore, 0);
  check('only the winner was paid', r1.paidCents, payoutCents(5000, -150));

  console.log('\npush refunds');
  const m2 = await makeMarket('h2h', { home: -110, away: -110 });
  await placeBet({ slug: A, marketId: m2, optionKey: 'home', stakeCents: 3000 });
  const pushBefore = await balanceOf(A);
  await settleMarket(m2, 'push');
  check('stake returned exactly', (await balanceOf(A)) - pushBefore, 3000);
  const [pushBet] = await sql`select status, payout_cents from bets where market_id = ${m2}`;
  check('marked as a push', pushBet.status, 'push');
  check('payout is the stake', Number(pushBet.payout_cents), 3000);

  console.log('\nvoid refunds');
  // A prop on a player who never started: nobody could have won it.
  const m3 = await makeMarket('prop', { over: -110, under: -110 }, { playerId: '999', line: 20 });
  await placeBet({ slug: A, marketId: m3, optionKey: 'over', stakeCents: 4000 });
  await placeBet({ slug: B, marketId: m3, optionKey: 'under', stakeCents: 2500 });
  const vaBefore = await balanceOf(A);
  const vbBefore = await balanceOf(B);
  await settleMarket(m3, 'void');
  check('over side refunded', (await balanceOf(A)) - vaBefore, 4000);
  check('under side refunded too', (await balanceOf(B)) - vbBefore, 2500);
  const voided = await sql`select status from bets where market_id = ${m3} order by id`;
  check('both marked void, not lost', voided.map((v) => v.status), ['void', 'void']);
  const [vm] = await sql`select status from markets where id = ${m3}`;
  check('market is void, not settled', vm.status, 'void');

  console.log('\nno double payouts');
  let threw = null;
  try {
    await settleMarket(m1, 'home');
  } catch (e) {
    threw = e.message;
  }
  check('re-settling a settled market throws', threw, 'Market is already settled.');
  let threwVoid = null;
  try {
    await settleMarket(m3, 'void');
  } catch (e) {
    threwVoid = e.message;
  }
  check('re-settling a voided market throws', threwVoid, 'Market is already settled.');

  console.log('\nledger stays consistent');
  const [{ sum }] = await sql`
    select coalesce(sum(amount_cents), 0)::bigint as sum from ledger where bettor = ${A}`;
  const [bank] = await sql`select balance_cents from bankrolls where slug = ${A}`;
  check('balance equals the ledger', Number(bank.balance_cents), Number(sum));

  // Every stake must have exactly one matching outcome row.
  const [{ orphans }] = await sql`
    select count(*)::int as orphans from bets b
    where b.status <> 'pending'
      and b.payout_cents > 0
      and not exists (select 1 from ledger l where l.bet_id = b.id and l.reason in ('payout', 'refund'))`;
  check('no paid bet is missing its ledger row', orphans, 0);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);
// Real league bets now exist, so a flat $1000 is no longer the invariant.
// What must hold is that every balance is explained by its own ledger.
const mismatched = await sql`
  select b.slug from bankrolls b
  join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
    on l.bettor = b.slug
  where b.balance_cents <> l.total
  order by b.slug`;
check(
  'every balance equals its ledger',
  mismatched.map((r) => r.slug),
  [],
);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
