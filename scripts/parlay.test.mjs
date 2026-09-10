/**
 * Parlays, against the real database.
 *
 * The rule that matters most: a parlay dies if any leg loses, and pays only
 * when every leg is in. The second-most: a voided leg drops out and the rest
 * are re-priced, so a two-leg slip with one dead leg becomes a straight bet on
 * the survivor rather than a whole refund.
 */
import { neon } from '@neondatabase/serverless';
import { placeParlay, settleMarket, getBankrolls, getMyBets, settledBets } from '../lib/book.js';
import { payoutCents, parlayOdds } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9997;

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

const A = 'chris-nicholson';
const balanceOf = async (slug) =>
  Number((await getBankrolls()).find((r) => r.slug === slug).balance_cents);

async function makeMarket({ locked = false, odds = -110 } = {}) {
  const locksAt = locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3);
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, meta)
    values (${TEST_SEASON}, 1, 'h2h', ${'PARLAY TEST ' + Math.random()}, ${locksAt}, ${locked ? 'locked' : 'open'}, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', ${odds}), (${m.id}, 'away', 'Away', ${odds})`;
  return Number(m.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  if (ids.length) {
    const betIds = (
      await sql`select distinct bet_id from parlay_legs where market_id = any(${ids})`
    ).map((r) => r.bet_id);
    await sql`delete from parlay_legs where market_id = any(${ids})`;
    if (betIds.length) {
      await sql`delete from ledger where bet_id = any(${betIds})`;
      await sql`delete from bets where id = any(${betIds})`;
    }
    await sql`delete from ledger where bet_id in (select id from bets where market_id = any(${ids}))`;
    await sql`delete from bets where market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
}

await cleanup();

try {
  console.log('\nplacing');
  const m1 = await makeMarket();
  const m2 = await makeMarket();
  const m3 = await makeMarket();
  const before = await balanceOf(A);
  const parlay = await placeParlay({
    slug: A,
    stakeCents: 5000,
    legs: [
      { marketId: m1, optionKey: 'home' },
      { marketId: m2, optionKey: 'home' },
      { marketId: m3, optionKey: 'home' },
    ],
  });
  check('three legs recorded', parlay.legs, 3);
  check('combined odds match the math', parlay.combinedOdds, parlayOdds([-110, -110, -110]));
  check('stake debited once', before - (await balanceOf(A)), 5000);
  const [{ n }] = await sql`select count(*)::int as n from parlay_legs where bet_id = ${parlay.id}`;
  check('legs stored', n, 3);

  console.log('\nparlays appear wherever bets are listed');
  // This join has been wrong three separate times: getMyBets, settledBets and
  // settledSummary all inner-joined markets and market_options, which a parlay
  // has neither of, so every parlay silently vanished from the UI.
  const mine = await getMyBets(A);
  const found = mine.find((b) => String(b.id) === String(parlay.id));
  check('a pending parlay is in my bets', Boolean(found), true);
  check('and reports its leg count', found?.leg_count, 3);

  console.log('\nrules');
  await rejects(
    'needs at least two legs',
    () => placeParlay({ slug: A, stakeCents: 5000, legs: [{ marketId: m1, optionKey: 'home' }] }),
    'at least 2 legs',
  );
  await rejects(
    'rejects two legs on one market',
    () =>
      placeParlay({
        slug: A,
        stakeCents: 5000,
        legs: [
          { marketId: m1, optionKey: 'home' },
          { marketId: m1, optionKey: 'away' },
        ],
      }),
    'different market',
  );
  const mLocked = await makeMarket({ locked: true });
  await rejects(
    'rejects a locked leg',
    () =>
      placeParlay({
        slug: A,
        stakeCents: 5000,
        legs: [
          { marketId: m1, optionKey: 'home' },
          { marketId: mLocked, optionKey: 'home' },
        ],
      }),
    'closed',
  );
  await rejects(
    'rejects an option that does not exist',
    () =>
      placeParlay({
        slug: A,
        stakeCents: 5000,
        legs: [
          { marketId: m1, optionKey: 'home' },
          { marketId: m2, optionKey: 'nope' },
        ],
      }),
    'does not exist',
  );
  await rejects(
    'rejects over the stake limit',
    () =>
      placeParlay({
        slug: A,
        stakeCents: 30000,
        legs: [
          { marketId: m1, optionKey: 'home' },
          { marketId: m2, optionKey: 'home' },
        ],
      }),
    'maximum',
  );

  console.log('\none losing leg kills it');
  await settleMarket(m1, 'home'); // leg 1 wins
  let [bet] = await sql`select status from bets where id = ${parlay.id}`;
  check('still pending after one win', bet.status, 'pending');
  const beforeLoss = await balanceOf(A);
  await settleMarket(m2, 'away'); // leg 2 loses
  [bet] = await sql`select status, payout_cents from bets where id = ${parlay.id}`;
  check('dead as soon as a leg loses', bet.status, 'lost');
  check('pays nothing', Number(bet.payout_cents), 0);
  check('no money moves on a loss', await balanceOf(A), beforeLoss);
  check('does not wait for the last leg', (await sql`select status from parlay_legs where bet_id = ${parlay.id} and market_id = ${m3}`)[0].status, 'pending');

  console.log('\nall legs win');
  const w1 = await makeMarket();
  const w2 = await makeMarket();
  const winner = await placeParlay({
    slug: A,
    stakeCents: 4000,
    legs: [
      { marketId: w1, optionKey: 'home' },
      { marketId: w2, optionKey: 'home' },
    ],
  });
  const beforeWin = await balanceOf(A);
  await settleMarket(w1, 'home');
  check('not paid until every leg is in', await balanceOf(A), beforeWin);
  await settleMarket(w2, 'home');
  const expectedPayout = payoutCents(4000, parlayOdds([-110, -110]));
  check('paid the combined price', (await balanceOf(A)) - beforeWin, expectedPayout);
  const [wonBet] = await sql`select status, payout_cents from bets where id = ${winner.id}`;
  check('marked won', wonBet.status, 'won');
  check('payout stored', Number(wonBet.payout_cents), expectedPayout);

  console.log('\na voided leg drops out');
  const v1 = await makeMarket();
  const v2 = await makeMarket();
  const mixed = await placeParlay({
    slug: A,
    stakeCents: 3000,
    legs: [
      { marketId: v1, optionKey: 'home' },
      { marketId: v2, optionKey: 'home' },
    ],
  });
  const beforeMixed = await balanceOf(A);
  await settleMarket(v1, 'home'); // wins
  await settleMarket(v2, 'void'); // drops out
  const [mixedBet] = await sql`select status, payout_cents, parlay_odds from bets where id = ${mixed.id}`;
  check('still a winner', mixedBet.status, 'won');
  // With one leg gone this is a straight bet on the survivor, priced at its own
  // odds rather than the original two-leg price.
  check('re-priced to the surviving leg', mixedBet.parlay_odds, -110);
  check('paid as a single -110 bet', (await balanceOf(A)) - beforeMixed, payoutCents(3000, -110));

  console.log('\nledger integrity');
  const mismatched = await sql`
    select b.slug from bankrolls b
    join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
      on l.bettor = b.slug
    where b.balance_cents <> l.total`;
  check('every balance equals its ledger', mismatched.map((r) => r.slug), []);
  const [{ dupes }] = await sql`
    select count(*)::int as dupes from (
      select bet_id, reason, count(*) from ledger
      where bet_id is not null and reason in ('payout', 'refund')
      group by bet_id, reason having count(*) > 1
    ) x`;
  check('no bet paid twice', dupes, 0);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ left }] = await sql`select count(*)::int as left from markets where season = ${TEST_SEASON}`;
check('test data removed', left, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
