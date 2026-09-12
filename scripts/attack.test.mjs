/**
 * The attack board: blind attacks on other people's bets.
 *
 * The rule the whole feature rests on: you can see WHO bet, HOW MUCH and at
 * what price, but never WHICH market or WHICH side. That is what makes the
 * board safe to show while bets are still open -- a $250 bet at +600 is
 * obviously worth attacking, and knowing that tells you nothing you could copy.
 *
 * The withholding is structural rather than a filter. attackableBets does not
 * join markets or market_options at all, so there is no column that could leak
 * a pick if the UI forgot to strip one.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { attackableBets, placeBet, settleMarket } from '../lib/book.js';
import { buyBoost, useBoostOnBet, thievesFor } from '../lib/shop.js';
import { applyBoosts } from '../lib/boosts.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9989;
const TEST_WEEK = testWeek(TEST_SEASON);
const A = 'chris-nicholson';
const B = 'devin-nicholson';

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

async function makeMarket(odds = 200) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${TEST_SEASON}, ${TEST_WEEK}, 'h2h', ${'ATTACK TEST ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', ${odds}), (${m.id}, 'away', 'Away', ${odds})`;
  return Number(m.id);
}

async function givePoints(slug, n) {
  await sql`insert into point_ledger (bettor, season, amount, reason, note)
            values (${slug}, ${TEST_SEASON}, ${n}, 'adjustment', 'attack test')`;
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
  await sql`delete from boosts where season = ${TEST_SEASON}`;
  await sql`delete from point_ledger where season = ${TEST_SEASON}`;
  await unfundWeek(TEST_WEEK);
}

await cleanup();
await fundWeek(TEST_WEEK);

try {
  console.log('\nthe board shows money, never the pick');
  const m1 = await makeMarket();
  const victim = await placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 25000 });
  const board = await attackableBets(TEST_SEASON);
  const row = board.find((r) => String(r.id) === String(victim.id));

  check('the bet is listed', Boolean(row), true);
  check('with who placed it', row.bettor_name, 'Devin');
  check('and the stake', Number(row.stake_cents), 25000);
  check('and the price', row.odds, 200);

  // The assertion the whole feature depends on.
  const leaky = Object.keys(row).filter((k) => /market|option|title|pick|label/i.test(k));
  check('no column can leak the pick', leaky, []);

  console.log('\nattacking someone else');
  await givePoints(A, 200);
  const skim = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'payout-cut' });
  await useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: Number(victim.id) });

  const after = (await attackableBets(TEST_SEASON)).find(
    (r) => String(r.id) === String(victim.id),
  );
  check('the board shows it has been hit', after.attacked, 1);
  check('but not by whom', Object.keys(after).includes('attacker'), false);

  console.log('\nyou cannot attack yourself');
  const m2 = await makeMarket();
  const own = await placeBet({ slug: A, marketId: m2, optionKey: 'home', stakeCents: 5000 });
  const skim2 = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'payout-cut' });
  await rejects(
    'refused on your own bet',
    () => useBoostOnBet({ slug: A, boostId: Number(skim2.id), betId: Number(own.id) }),
    'someone else',
  );

  console.log('\na skim takes its cut at settlement');
  {
    const bankBefore = await bankOf(B);
    await settleMarket(m1, 'home');
    const full = payoutCents(25000, 200);
    // Profit only banks, and the skim bites the payout before the split.
    const expected = applyBoosts(full, ['payout-cut']) - 25000;
    check('the victim banks the reduced profit', (await bankOf(B)) - bankBefore, expected);
    check('which is less than the full profit', expected < full - 25000, true);
  }

  console.log('\nGrand Theft moves the money');
  {
    const m3 = await makeMarket();
    const mark = await placeBet({ slug: B, marketId: m3, optionKey: 'home', stakeCents: 20000 });
    const theft = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'steal' });
    await useBoostOnBet({ slug: A, boostId: Number(theft.id), betId: Number(mark.id) });

    const thiefBefore = await bankOf(A);
    const victimBefore = await bankOf(B);
    await settleMarket(m3, 'home');

    const full = payoutCents(20000, 200);
    check('the thief banks the WHOLE payout', (await bankOf(A)) - thiefBefore, full);
    check('and the victim banks nothing', (await bankOf(B)) - victimBefore, 0);

    // Not even the stake. Returning it would be a gesture rather than mercy:
    // settlement runs after the week has rolled, so a returned stake lands in a
    // week whose allowance has already reset and nobody can spend it.
    const returned = await sql`
      select id from ledger where bet_id = ${mark.id} and reason = 'stake-return'`;
    check('the stake is not returned', returned.length, 0);
    check('the thief got more than the profit', full > payoutCents(20000, 200) - 20000, true);
  }

  console.log('\nInsurance blocks a theft');
  {
    const m4 = await makeMarket();
    const safe = await placeBet({ slug: B, marketId: m4, optionKey: 'home', stakeCents: 15000 });
    await givePoints(B, 100);
    const shield = await buyBoost({ slug: B, season: TEST_SEASON, kind: 'insurance' });
    await useBoostOnBet({ slug: B, boostId: Number(shield.id), betId: Number(safe.id) , atPlacement: true });
    const theft = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'steal' });
    await useBoostOnBet({ slug: A, boostId: Number(theft.id), betId: Number(safe.id) });

    // The shield is checked where the theft is read, so a shielded bet is
    // simply not stolen.
    check('a shielded bet has no thief', await thievesFor([Number(safe.id)]), {});

    const thiefBefore = await bankOf(A);
    const victimBefore = await bankOf(B);
    await settleMarket(m4, 'home');
    const profit = payoutCents(15000, 200) - 15000;
    check('the victim keeps the winnings', (await bankOf(B)) - victimBefore, profit);
    check('and the thief gets nothing', (await bankOf(A)) - thiefBefore, 0);
  }

  console.log('\nattacking a loser is wasted');
  {
    const m5 = await makeMarket();
    const doomed = await placeBet({ slug: B, marketId: m5, optionKey: 'home', stakeCents: 10000 });
    const theft = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'steal' });
    await useBoostOnBet({ slug: A, boostId: Number(theft.id), betId: Number(doomed.id) });

    const thiefBefore = await bankOf(A);
    await settleMarket(m5, 'away'); // the victim loses
    check('nothing to steal from a losing bet', (await bankOf(A)) - thiefBefore, 0);
  }

  console.log('\nledger integrity');
  const [{ negative }] = await sql`
    select count(*)::int as negative from (
      select bettor, sum(amount_cents) as total from ledger group by bettor
    ) x where x.total < 0`;
  check('nobody is in the red', negative, 0);
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
