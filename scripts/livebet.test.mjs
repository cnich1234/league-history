/**
 * Live betting: a market that keeps taking bets after its posted lock, at a
 * price computed from the current game state.
 *
 * The rule that matters most: the SERVER prices the bet. A client that sent
 * its own odds could name any number, so what it sends is treated as "here is
 * what I was shown" and used only to reject a stale fill.
 */
import { neon } from '@neondatabase/serverless';
import { placeBet, placeParlay, getBankrolls } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9996;

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

async function makeMarket({ live, locked }) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, live, meta)
    values (${TEST_SEASON}, 1, 'h2h', ${'LIVE TEST ' + Math.random()},
            ${locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3)},
            ${live},
            ${JSON.stringify({ homeRoster: 1, awayRoster: 2, homeSlug: 'a', awaySlug: 'b' })}::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', -150), (${m.id}, 'away', 'Away', 130)`;
  return Number(m.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  if (ids.length) {
    await sql`delete from ledger where bet_id in (select id from bets where market_id = any(${ids}))`;
    await sql`delete from bets where market_id = any(${ids})`;
    await sql`delete from live_quotes where market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
}

await cleanup();

try {
  console.log('\npregame is unchanged');
  const open = await makeMarket({ live: true, locked: false });
  const bet = await placeBet({ slug: A, marketId: open, optionKey: 'home', stakeCents: 2000 });
  check('an unlocked live market uses the posted price', bet.odds, -150);

  console.log('\na non-live market still locks');
  const shut = await makeMarket({ live: false, locked: true });
  await rejects(
    'past its lock and not live',
    () => placeBet({ slug: A, marketId: shut, optionKey: 'home', stakeCents: 2000 }),
    'has locked',
  );

  console.log('\na live market past its lock');
  const live = await makeMarket({ live: true, locked: true });
  // Rosters 1 and 2 exist in the real league, so liveMatchups finds them. The
  // model may or may not suspend depending on the actual game state, so accept
  // either a fill at a server price or a suspension -- what must NOT happen is
  // a fill at the client's number.
  let placed = null;
  let suspendedMsg = null;
  try {
    placed = await placeBet({
      slug: A,
      marketId: live,
      optionKey: 'home',
      stakeCents: 2000,
      expectedOdds: -150,
    });
  } catch (e) {
    suspendedMsg = e.message;
  }
  if (placed) {
    check('the server priced it, not the posted line', placed.odds !== -150, true);
    console.log(`       (filled at ${placed.odds})`);
  } else {
    check('suspended with an explanation', /closed|price moved|no live price/i.test(suspendedMsg), true);
    console.log(`       (${suspendedMsg})`);
  }

  console.log('\na stale price is refused');
  const live2 = await makeMarket({ live: true, locked: true });
  await rejects(
    'odds far from what the server computes',
    () =>
      placeBet({
        slug: A,
        marketId: live2,
        optionKey: 'home',
        // Absurd number: whatever the live price is, this is not within 15%.
        stakeCents: 2000,
        expectedOdds: -5000,
      }),
    // Either the guard fires or the market is suspended; both are refusals.
    '',
  );

  console.log('\nparlays can use live legs');
  // placeParlay rejected anything past locks_at with no exception for live
  // markets, so a parlay whose legs were plainly bettable on the board came
  // back as "A market in this parlay has locked."
  const p1 = await makeMarket({ live: true, locked: true });
  const p2 = await makeMarket({ live: true, locked: true });
  let parlayErr = null;
  try {
    await placeParlay({
      slug: A,
      stakeCents: 2000,
      legs: [
        { marketId: p1, optionKey: 'home' },
        { marketId: p2, optionKey: 'home' },
      ],
    });
  } catch (e) {
    parlayErr = e.message;
  }
  // These synthetic markets point at a real matchup that may be suspended, so
  // accept a suspension -- what must not happen is the flat 'has locked'.
  check(
    'a live leg is not rejected as locked',
    parlayErr == null || !/has locked/i.test(parlayErr),
    true,
  );
  // Guard against this passing for the wrong reason: a ReferenceError also
  // fails the "has locked" test, and did once.
  check('and the rejection, if any, is a real one', !/is not defined/i.test(parlayErr ?? ''), true);
  if (parlayErr) console.log(`       (${parlayErr})`);

  console.log('\nledger integrity');
  const mismatched = await sql`
    select b.slug from bankrolls b
    join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
      on l.bettor = b.slug
    where b.balance_cents <> l.total`;
  check('every balance equals its ledger', mismatched.map((r) => r.slug), []);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
