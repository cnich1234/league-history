/**
 * The shop against the real database.
 *
 * The invariant that matters most is the same one the money ledger has: a
 * balance is the sum of its history, never a stored number. If those can
 * disagree, someone can spend points they do not have.
 *
 * Second: the weekly allowance must be idempotent. A cron that fires twice, or
 * a manual re-run, must not double-pay -- enforced by a unique index rather
 * than by remembering to check.
 */
import { neon } from '@neondatabase/serverless';
import {
  getPoints,
  getPointBalances,
  grantWeeklyAllowance,
  grantTrophyPoints,
  buyBoost,
  getInventory,
  useBoostOnBet,
  useBoostOnMarket,
  boostsForBets,
  marketPenalty,
  consumeOddsBoost,
  hasArmedOddsBoost,
} from '../lib/shop.js';
import { WEEKLY_ALLOWANCE, byKind } from '../lib/boosts.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9993;
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

async function makeMarket({ locked = false } = {}) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${TEST_SEASON}, 1, 'h2h', ${'SHOP TEST ' + Math.random()},
            ${locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3)},
            'open', true, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', -110), (${m.id}, 'away', 'Away', -110)`;
  return Number(m.id);
}

async function makeBet(slug, marketId) {
  const [b] = await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds, status)
    values (${slug}, ${marketId}, 'home', 2500, -110, 'pending') returning id`;
  return Number(b.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  const betIds = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  if (betIds.length) await sql`delete from boosts where target_bet_id = any(${betIds})`;
  if (ids.length) await sql`delete from boosts where target_market_id = any(${ids})`;
  await sql`delete from boosts where season = ${TEST_SEASON}`;
  if (betIds.length) {
    await sql`delete from ledger where bet_id = any(${betIds})`;
    await sql`delete from bets where id = any(${betIds})`;
  }
  if (ids.length) {
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await sql`delete from point_ledger where season = ${TEST_SEASON}`;
}

await cleanup();

try {
  console.log('\nthe weekly allowance');
  const granted = await grantWeeklyAllowance(TEST_SEASON, 1);
  check('everyone gets it', granted.length > 0, true);
  const after = await sql`
    select coalesce(sum(amount),0)::int as n from point_ledger
    where bettor = ${A} and season = ${TEST_SEASON}`;
  check('credited the right amount', after[0].n, WEEKLY_ALLOWANCE);

  // The bug this guards: a cron firing twice, or a manual re-run.
  const again = await grantWeeklyAllowance(TEST_SEASON, 1);
  check('running it twice grants nothing', again.length, 0);
  const stillOne = await sql`
    select coalesce(sum(amount),0)::int as n from point_ledger
    where bettor = ${A} and season = ${TEST_SEASON}`;
  check('and the balance is unchanged', stillOne[0].n, WEEKLY_ALLOWANCE);

  console.log('\ntrophy points');
  await grantTrophyPoints(TEST_SEASON, 1, { [A]: 7, [B]: 3 });
  const withTrophies = await sql`
    select coalesce(sum(amount),0)::int as n from point_ledger
    where bettor = ${A} and season = ${TEST_SEASON}`;
  check('added on top of the allowance', withTrophies[0].n, WEEKLY_ALLOWANCE + 7);
  await grantTrophyPoints(TEST_SEASON, 1, { [A]: 7 });
  const notDoubled = await sql`
    select coalesce(sum(amount),0)::int as n from point_ledger
    where bettor = ${A} and season = ${TEST_SEASON}`;
  check('re-scoring a week does not double-pay', notDoubled[0].n, WEEKLY_ALLOWANCE + 7);

  console.log('\nbuying');
  const before = await getPoints(A, TEST_SEASON);
  const bought = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'insurance' });
  check('a boost appears', bought.kind, 'insurance');
  check('points are debited', before - (await getPoints(A, TEST_SEASON)), byKind['insurance'].cost);
  const inv = await getInventory(A, TEST_SEASON);
  check(
    'and it is in the inventory',
    inv.some((b) => Number(b.id) === Number(bought.id)),
    true,
  );

  // B has 5 allowance + 3 trophies = 8 in this season, so pick something that
  // is genuinely out of reach rather than assuming.
  const bPoints = await getPoints(B, TEST_SEASON);
  const dear = Object.values(byKind).find((d) => d.cost > bPoints);
  await rejects(
    'cannot buy what you cannot afford',
    () => buyBoost({ slug: B, season: TEST_SEASON, kind: dear.kind }),
    'not enough',
  );

  // Points are per season: last season's leftovers must not be spendable now.
  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${B}, ${TEST_SEASON - 1}, 500, 'adjustment', 'previous season')`;
  check('an old season does not fund this one', await getPoints(B, TEST_SEASON), bPoints);
  await rejects(
    'and cannot be spent',
    () => buyBoost({ slug: B, season: TEST_SEASON, kind: dear.kind }),
    'not enough',
  );
  await sql`delete from point_ledger where bettor = ${B} and season = ${TEST_SEASON - 1}`;
  await rejects(
    'cannot buy something that does not exist',
    () => buyBoost({ slug: A, season: TEST_SEASON, kind: 'wallhack' }),
    'no such boost',
  );

  console.log('\nusing a boost on a bet');
  const market = await makeMarket();
  const myBet = await makeBet(A, market);
  await useBoostOnBet({ slug: A, boostId: Number(bought.id), betId: myBet });
  const held = await boostsForBets([myBet]);
  check('the bet carries it', held[myBet], ['insurance']);

  await rejects(
    'cannot use the same boost twice',
    () => useBoostOnBet({ slug: A, boostId: Number(bought.id), betId: myBet }),
    'already been used',
  );

  const second = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'insurance' });
  await rejects(
    'cannot stack two of a kind on one bet',
    () => useBoostOnBet({ slug: A, boostId: Number(second.id), betId: myBet }),
    'already has',
  );

  console.log('\nownership and targeting');
  const theirBet = await makeBet(B, market);
  await rejects(
    'cannot use a boost you do not own',
    () => useBoostOnBet({ slug: B, boostId: Number(second.id), betId: theirBet }),
    'not yours',
  );
  await rejects(
    'insurance cannot be put on someone else',
    () => useBoostOnBet({ slug: A, boostId: Number(second.id), betId: theirBet }),
    'your own bet',
  );

  await grantTrophyPoints(TEST_SEASON, 2, { [A]: 40 });
  const skim = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'payout-cut' });
  await rejects(
    'an attack cannot go on your own bet',
    () => useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: myBet }),
    'for someone else',
  );
  await useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: theirBet });
  const theirs = await boostsForBets([theirBet]);
  check('but it does go on theirs', theirs[theirBet], ['payout-cut']);

  console.log('\npoisoning a market');
  const poison = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'market-poison' });
  check('no penalty to begin with', await marketPenalty(market), 0);
  await useBoostOnMarket({ slug: A, boostId: Number(poison.id), marketId: market });
  check('the market is now worse', await marketPenalty(market), byKind['market-poison'].marginBump);

  const shutMarket = await makeMarket({ locked: true });
  await sql`update markets set live = false, status = 'locked' where id = ${shutMarket}`;
  const poison2 = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'market-poison' });
  await rejects(
    'cannot poison a market whose prices are fixed',
    () => useBoostOnMarket({ slug: A, boostId: Number(poison2.id), marketId: shutMarket }),
    'closed',
  );

  console.log('\nthe odds boost is consumed once, atomically');
  {
    await grantTrophyPoints(TEST_SEASON, 3, { [A]: 30 });
    const ob = await buyBoost({ slug: A, season: TEST_SEASON, kind: 'odds-boost' });
    check('armed', await hasArmedOddsBoost(A, TEST_SEASON), true);

    // Two placements racing for one boost: exactly one may win it. Without the
    // `used_at is null` guard on the update, both would claim the same boost
    // and one of them would get a free price.
    const [a, b] = await Promise.all([
      consumeOddsBoost({ slug: A, season: TEST_SEASON, odds: 200 }),
      consumeOddsBoost({ slug: A, season: TEST_SEASON, odds: 200 }),
    ]);
    const winners = [a, b].filter(Boolean);
    check('exactly one placement gets it', winners.length, 1);
    check('and it improved the price', winners[0].odds, 300);
    check('nothing is armed afterwards', await hasArmedOddsBoost(A, TEST_SEASON), false);

    const spent = await sql`select used_at from boosts where id = ${Number(ob.id)}`;
    check('the boost is marked used', Boolean(spent[0].used_at), true);

    check('and a later placement gets nothing',
      await consumeOddsBoost({ slug: A, season: TEST_SEASON, odds: 200 }), null);
  }

  console.log('\ncoming-soon boosts cannot be bought');
  await rejects(
    'refused at the data layer, not just greyed in the shop',
    () => buyBoost({ slug: A, season: TEST_SEASON, kind: 'steal' }),
    'not available yet',
  );

  console.log('\nledger integrity');
  const balances = await getPointBalances(TEST_SEASON);
  const sums = await sql`
    select bettor, coalesce(sum(amount),0)::int as total from point_ledger
    where season = ${TEST_SEASON} group by bettor`;
  const bySlug = Object.fromEntries(sums.map((r) => [r.bettor, r.total]));
  const wrong = balances.filter((b) => Number(b.points) !== (bySlug[b.slug] ?? 0));
  check(
    'every balance equals its ledger',
    wrong.map((b) => b.slug),
    [],
  );
  const negative = balances.filter((b) => Number(b.points) < 0);
  check(
    'and nobody is in the red',
    negative.map((b) => b.slug),
    [],
  );
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from point_ledger where season = ${TEST_SEASON}`;
check('test points removed', n, 0);
const [{ b }] = await sql`select count(*)::int as b from boosts where season = ${TEST_SEASON}`;
check('test boosts removed', b, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
