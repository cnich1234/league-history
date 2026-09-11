/**
 * The weekly allowance, and what survives it.
 *
 * The model: $500 a week that does NOT carry over, and profit that banks
 * permanently. Most in the bank at the end of the season wins.
 *
 * The rule that makes it a game rather than a grind: only PROFIT banks. With a
 * weekly reset, losing costs nothing -- the allowance returns regardless. If a
 * winning bet banked its whole return, the optimal play would be the entire
 * allowance on the shortest favourite every single week, and the season would
 * go to whoever bet the most rather than whoever bet best.
 */
import { neon } from '@neondatabase/serverless';
import { placeBet, settleMarket, weeklyBalance, grantWeeklyAllowance, WEEKLY_ALLOWANCE_CENTS } from '../lib/book.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9992;
const A = 'chris-nicholson';

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
const rejects = async (label, fn, fragment) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a rejection)`);
    failed++;
  } catch (e) {
    if (!fragment || e.message.toLowerCase().includes(fragment.toLowerCase())) {
      console.log(`  ok   ${label}`);
    } else {
      console.log(`  FAIL ${label}: ${e.message}`);
      failed++;
    }
  }
};

const bankOf = async (slug) => {
  const [r] = await sql`select bank_cents from banks where slug = ${slug}`;
  return Number(r?.bank_cents ?? 0);
};

async function makeMarket(week, odds = 100) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${TEST_SEASON}, ${week}, 'h2h', ${'WEEKLY TEST ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', ${odds}), (${m.id}, 'away', 'Away', ${odds})`;
  return Number(m.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  const betIds = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  if (betIds.length) {
    await sql`delete from boosts where target_bet_id = any(${betIds})`;
    await sql`delete from ledger where bet_id = any(${betIds})`;
    await sql`delete from bets where id = any(${betIds})`;
  }
  if (ids.length) {
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  // Test weeks are far outside any real week number.
  await sql`delete from ledger where week in (901, 902)`;
}

await cleanup();

try {
  console.log('\nthe allowance');
  await grantWeeklyAllowance(901);
  check('credited', await weeklyBalance(A, 901), WEEKLY_ALLOWANCE_CENTS);

  // A cron that fires twice must not pay twice.
  await grantWeeklyAllowance(901);
  check('running it again grants nothing', await weeklyBalance(A, 901), WEEKLY_ALLOWANCE_CENTS);

  console.log('\nweeks do not share money');
  await grantWeeklyAllowance(902);
  check('a second week is its own pot', await weeklyBalance(A, 902), WEEKLY_ALLOWANCE_CENTS);
  const m1 = await makeMarket(901);
  await placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 20000 });
  check('spending week 901', await weeklyBalance(A, 901), WEEKLY_ALLOWANCE_CENTS - 20000);
  check('does not touch week 902', await weeklyBalance(A, 902), WEEKLY_ALLOWANCE_CENTS);

  console.log('\nyou cannot spend what the week does not have');
  const left901 = await weeklyBalance(A, 901);
  const m2 = await makeMarket(901);
  await rejects(
    'a stake beyond what is left is refused',
    () => placeBet({ slug: A, marketId: m2, optionKey: 'home', stakeCents: left901 + 1000 }),
    'not enough left this week',
  );

  // The allowance is the ceiling, and nothing caps a single bet below it. The
  // old $250 was a quarter of a $1,000 season bankroll and would have been half
  // a week here.
  const m2b = await makeMarket(902);
  const whole = await placeBet({
    slug: A,
    marketId: m2b,
    optionKey: 'home',
    stakeCents: WEEKLY_ALLOWANCE_CENTS,
  });
  check('the whole week can go on one bet', Number(whole.stake_cents), WEEKLY_ALLOWANCE_CENTS);
  await settleMarket(m2b, 'away');

  console.log('\nonly profit banks');
  {
    const bankBefore = await bankOf(A);
    const weekBefore = await weeklyBalance(A, 901);
    // $200 at +100 returns $400: $200 stake back, $200 profit.
    await settleMarket(m1, 'home');

    const expectedPayout = payoutCents(20000, 100);
    const expectedProfit = expectedPayout - 20000;

    check('the profit banked', (await bankOf(A)) - bankBefore, expectedProfit);
    // The stake is gone, won or lost. Returning it to the week it came from
    // looked fair and was pointless: settlement runs after the week has rolled,
    // so that money could never be spent.
    check('the stake is consumed', (await weeklyBalance(A, 901)) - weekBefore, 0);
    // The whole point: banking the full return would have been 40000.
    check('the full return did NOT bank', (await bankOf(A)) - bankBefore !== expectedPayout, true);
  }

  console.log('\na losing bet costs the week, not the bank');
  {
    // 902 was spent by the whole-week bet above. A fresh allowance would be
    // refused by the once-per-week index, so top it up as an adjustment.
    await sql`
      insert into ledger (bettor, amount_cents, reason, note, week)
      values (${A}, ${WEEKLY_ALLOWANCE_CENTS}, 'adjustment', 'test top-up', 902)`;
    const m3 = await makeMarket(902);
    const bankBefore = await bankOf(A);
    const weekBefore = await weeklyBalance(A, 902);
    await placeBet({ slug: A, marketId: m3, optionKey: 'home', stakeCents: 15000 });
    await settleMarket(m3, 'away');
    check('the bank is untouched', await bankOf(A), bankBefore);
    check('the week is down the stake', (await weeklyBalance(A, 902)) - weekBefore, -15000);
  }

  console.log('\na refund is all stake and banks nothing');
  {
    const m4 = await makeMarket(902);
    const bankBefore = await bankOf(A);
    const weekBefore = await weeklyBalance(A, 902);
    await placeBet({ slug: A, marketId: m4, optionKey: 'home', stakeCents: 10000 });
    await settleMarket(m4, 'push');
    check('nothing banked', await bankOf(A), bankBefore);
    // A refund is the exception: a pushed bet never really happened, so the
    // stake genuinely does come back rather than being consumed.
    check('and the week is whole again', await weeklyBalance(A, 902), weekBefore);
  }

  console.log('\nthe grind is not free');
  {
    // The scenario the profit-only rule exists to price correctly: the whole
    // allowance on a heavy favourite. It should bank the profit, not the return.
    const m5 = await makeMarket(902, -300);
    const bankBefore = await bankOf(A);
    const stake = await weeklyBalance(A, 902);
    await placeBet({ slug: A, marketId: m5, optionKey: 'home', stakeCents: stake });
    await settleMarket(m5, 'home');
    const banked = (await bankOf(A)) - bankBefore;
    const fullReturn = payoutCents(stake, -300);
    check('banks the profit only', banked, fullReturn - stake);
    check('which is much less than the return', banked < fullReturn / 2, true);
  }

  console.log('\nledger integrity');
  const [{ mismatch }] = await sql`
    select count(*)::int as mismatch from (
      select bettor, sum(amount_cents) as total from ledger where week = 901 group by bettor
    ) x where x.total < 0`;
  check('no week is overdrawn', mismatch, 0);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from ledger where week in (901, 902)`;
check('test ledger rows removed', n, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
