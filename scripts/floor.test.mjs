/**
 * The Floor shows everyone's bets, but only once nobody can act on them.
 *
 * This is the rule the whole game rests on -- bets stay hidden until their
 * market is finished with. It broke when live betting arrived: the filter was
 * `locks_at <= now()`, and a live market stays open past its posted lock, so
 * three real bets were on display while people could still take the other side.
 * One was a $250 stake.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, visibleBets } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9995;
// Own week, not week 1: week 1 is real and has real money in it.
const TEST_WEEK = testWeek(TEST_SEASON);
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

async function makeMarket({ live, locked, status = 'open' }) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, live, status, meta)
    values (${TEST_SEASON}, ${TEST_WEEK}, 'h2h', ${'FLOOR TEST ' + Math.random()},
            ${locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3)},
            ${live}, ${status},
            ${JSON.stringify({ homeRoster: 1, awayRoster: 2, homeSlug: 'a', awaySlug: 'b' })}::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', -110), (${m.id}, 'away', 'Away', -110)`;
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
  const seen = async () => (await visibleBets(TEST_SEASON, TEST_WEEK)).map((b) => Number(b.market_id));

  console.log('\nhidden while bettable');
  const openMarket = await makeMarket({ live: false, locked: false });
  await placeBet({ slug: A, marketId: openMarket, optionKey: 'home', stakeCents: 1000 });
  check('an unlocked market hides its bets', (await seen()).includes(openMarket), false);

  // The regression: a live market past its posted lock is STILL bettable, so
  // its bets must stay hidden. Inserted directly rather than through placeBet,
  // because these synthetic markets point at a real matchup that may be
  // suspended -- and what is under test is visibility, not placement.
  const liveMarket = await makeMarket({ live: true, locked: true });
  await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds)
    values (${A}, ${liveMarket}, 'home', 1000, -110)`;
  check('a live market past its lock still hides them', (await seen()).includes(liveMarket), false);

  console.log('\nrevealed once nobody can act');
  // "Closed" now means status, not a past locks_at: a prop's posted time is
  // midnight on the morning of the game, so revealing on that alone published a
  // bet while the game was still hours away.
  const doneMarket = await makeMarket({ live: false, locked: true, status: 'locked' });
  // Direct insert again: placeBet rightly refuses a locked market, and the
  // point here is what the Floor reveals afterwards.
  await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds)
    values (${A}, ${doneMarket}, 'home', 1000, -110)`;
  check('a locked non-live market reveals them', (await seen()).includes(doneMarket), true);

  // A live market that has been closed out is finished with, so it reveals.
  await sql`update markets set status = 'locked' where id = ${liveMarket}`;
  check('a live market reveals once it closes', (await seen()).includes(liveMarket), true);

  console.log('\nnothing bettable is ever shown');
  const exposed = await visibleBets(TEST_SEASON, TEST_WEEK);
  const ids = exposed.map((b) => Number(b.market_id));
  const stillOpen = ids.length
    ? await sql`select id from markets where id = any(${ids}) and live = true and status = 'open'`
    : [];
  check('no exposed bet sits on a still-bettable market', stillOpen.length, 0);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
