/**
 * Hedge and Lock In.
 *
 * Both bend a rule that exists for a reason, so both need the exception kept
 * narrow:
 *
 *   Hedge lifts one-bet-per-market, which stops anyone backing both sides at
 *   the same price and collecting either way. It opens exactly ONE extra slot,
 *   and the second bet pays whatever the market costs now.
 *
 *   Lock In freezes a live price for one person. Everyone else keeps betting
 *   the live market, it expires, and it can only fund one bet.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet } from '../lib/book.js';
import {
  buyBoost,
  openHedge,
  hedgedMarkets,
  lockInPrice,
  lockedPrice,
  lockedPrices,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9984;
const W = testWeek(S);
const A = 'chris-nicholson';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};
const rejects = async (label, fn, fragment) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a rejection)`);
    failed++;
  } catch (e) {
    const hit = !fragment || e.message.toLowerCase().includes(fragment.toLowerCase());
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${label}${hit ? '' : `: ${e.message}`}`);
    if (!hit) failed++;
  }
};

async function mkt({ live = false, started = false } = {}) {
  // A live market only quotes once its posted lock has passed; `started`
  // puts that in the past so a lock can be taken on it.
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'SB ' + Math.random()},
            ${new Date(Date.now() + (started ? -3600e3 : 86400e3))}, 'open', ${live}, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', 200), (${m.id}, 'away', 'Away', -250)`;
  return Number(m.id);
}

async function pts(n) {
  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${A}, ${S}, ${n}, 'adjustment', 'self boost test')`;
}

async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => r.id);
  const bids = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  if (bids.length) {
    await sql`delete from boosts where target_bet_id = any(${bids})`;
    await sql`delete from ledger where bet_id = any(${bids})`;
    await sql`delete from bets where id = any(${bids})`;
  }
  if (ids.length) {
    await sql`delete from boosts where target_market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await sql`delete from boosts where season = ${S}`;
  await sql`delete from point_ledger where season = ${S}`;
  await unfundWeek(W);
}

await clean();
await fundWeek(W);

try {
  await pts(400);

  console.log('\none bet per market, still');
  const m1 = await mkt();
  const first = await placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 10000 });
  await rejects(
    'a second bet is refused',
    () => placeBet({ slug: A, marketId: m1, optionKey: 'away', stakeCents: 5000 }),
    'already have a bet',
  );

  console.log('\nHedge opens exactly one slot');
  const hedge = await buyBoost({ slug: A, season: S, kind: 'hedge' });
  const opened = await openHedge({ slug: A, boostId: Number(hedge.id), betId: Number(first.id) });
  ok('opened on the right market', opened.marketId, String(m1));
  ok('and the market is listed', (await hedgedMarkets(A)).has(String(m1)), true);

  const other = await placeBet({ slug: A, marketId: m1, optionKey: 'away', stakeCents: 5000 });
  ok('the other side went on', other.odds, -250);

  // The slot is spent. A third bet is refused again.
  await rejects(
    'a third bet is refused',
    () => placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 2000 }),
    'already have a bet',
  );
  ok('and the hedge is used up', (await hedgedMarkets(A)).has(String(m1)), false);

  console.log('\nHedge rules');
  const m2 = await mkt();
  const h2 = await buyBoost({ slug: A, season: S, kind: 'hedge' });
  await rejects(
    'refused on a bet that is not yours',
    async () => {
      const [theirs] = await sql`
        insert into bets (bettor, market_id, option_key, stake_cents, odds, status)
        values ('devin-nicholson', ${m2}, 'home', 5000, 200, 'pending') returning id`;
      await openHedge({ slug: A, boostId: Number(h2.id), betId: Number(theirs.id) });
    },
    'your own bet',
  );

  console.log('\nLock In freezes a price');
  const m3 = await mkt({ live: true, started: true });
  const lock = await buyBoost({ slug: A, season: S, kind: 'lock-in' });
  // The MODEL's price, injected. The request used to carry the odds, which
  // would have let a client lock any number it liked.
  const locked = await lockInPrice({
    slug: A,
    boostId: Number(lock.id),
    marketId: m3,
    optionKey: 'home',
    priceNow: async () => ({ odds: 350, probability: 0.22 }),
  });
  ok('the price is held', locked.odds, 350);
  ok('and listed for the board', (await lockedPrices(A))[String(m3)]?.odds, 350);
  ok('and readable back', (await lockedPrice({ slug: A, marketId: m3, optionKey: 'home' }))?.odds, 350);

  // Only for that option -- locking one side does not hold the other.
  ok(
    'the other side is not locked',
    await lockedPrice({ slug: A, marketId: m3, optionKey: 'away' }),
    null,
  );

  // And only for that person.
  ok(
    'nor is it locked for anyone else',
    await lockedPrice({ slug: 'devin-nicholson', marketId: m3, optionKey: 'home' }),
    null,
  );

  console.log('\nLock In rules');
  const m4 = await mkt({ live: false });
  const lock2 = await buyBoost({ slug: A, season: S, kind: 'lock-in' });
  await rejects(
    'a pregame line cannot be locked',
    () =>
      lockInPrice({
        slug: A,
        boostId: Number(lock2.id),
        marketId: m4,
        optionKey: 'home',
        priceNow: async () => ({ odds: 200, probability: 0.33 }),
      }),
    'not going anywhere',
  );

  // A live market whose games have not started has no live price to freeze.
  const m5 = await mkt({ live: true });
  const lock3 = await buyBoost({ slug: A, season: S, kind: 'lock-in' });
  await rejects(
    'nor can a live market be locked before kickoff',
    () =>
      lockInPrice({
        slug: A,
        boostId: Number(lock3.id),
        marketId: m5,
        optionKey: 'home',
        priceNow: async () => ({ odds: 200, probability: 0.33 }),
      }),
    'not live yet',
  );

  // An expired lock is simply not found.
  await sql`
    update boosts
    set detail = detail || ${JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() })}::jsonb
    where id = ${Number(lock.id)}`;
  ok(
    'an expired lock is gone',
    await lockedPrice({ slug: A, marketId: m3, optionKey: 'home' }),
    null,
  );
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
