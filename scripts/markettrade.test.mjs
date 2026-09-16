/**
 * Trading against the database, in a sentinel season nobody plays.
 *
 * Uses real bettor slugs (the ledger has a foreign key to bettors) but only
 * ever writes rows with season 9985, and deletes them all at the end -- the
 * shop reads points per season, so nothing here touches a real balance.
 */
import { neon } from '@neondatabase/serverless';
import {
  SPREAD,
  MAX_SHARES,
  quoteFor,
  costToBuy,
  proceedsToSell,
  pointsFor,
  holdingsFor,
  heldPlayerIds,
  ordersFor,
  placeOrder,
  cancelOrder,
  fillOrders,
  payDividends,
  dividendsFor,
} from '../lib/market/trading.js';

const SEASON = 9985;
const A = 'chris-nicholson';
const B = 'devin-nicholson';
const sql = neon(process.env.DATABASE_URL);

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` + (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
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

async function clean() {
  await sql`delete from market_dividends where season = ${SEASON}`;
  await sql`delete from market_orders where season = ${SEASON}`;
  await sql`delete from market_holdings where season = ${SEASON}`;
  await sql`delete from point_ledger where season = ${SEASON}`;
}
await clean();
await sql`insert into point_ledger (bettor, season, week, amount, reason, note) values (${A}, ${SEASON}, null, 30, 'adjustment', 'test opening')`;
await sql`insert into point_ledger (bettor, season, week, amount, reason, note) values (${B}, ${SEASON}, null, 5, 'adjustment', 'test opening')`;

console.log('\nthe arithmetic');
{
  ok('a 5% spread', SPREAD, 0.05);
  ok('bid and ask straddle the price', quoteFor(10), { bid: 9.75, ask: 10.25 });
  ok('a buy rounds up to whole points', costToBuy(10, 1), 11);
  ok('three shares at 10 cost 31', costToBuy(10, 3), 31);
  ok('a sell rounds down', proceedsToSell(10, 1), 9);
  ok('three shares at 10 pay 29', proceedsToSell(10, 3), 29);
  ok('round trip on one share loses 2 points at 10', costToBuy(10, 1) - proceedsToSell(10, 1), 2);
}

console.log('\nplacing orders');
{
  ok('A starts with 30', await pointsFor(A, SEASON), 30);
  const o = await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p1', side: 'buy', shares: 2, price: 10 });
  ok('an order queues as pending', o.status, 'pending');
  await rejects('cannot sell what you do not hold', () => placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p1', side: 'sell', shares: 1, price: 10 }), 'to sell');
  await rejects('cannot buy past the cap, pending included', () => placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p1', side: 'buy', shares: MAX_SHARES - 1, price: 10 }), 'at most');
  await rejects('cannot buy what you cannot afford', () => placeOrder({ owner: B, season: SEASON, week: 2, playerId: 'p1', side: 'buy', shares: 1, price: 10 }), 'points');
  await rejects('shares must be whole', () => placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p1', side: 'buy', shares: 1.5, price: 10 }), 'whole');
  ok('a pending buy keeps the player priced', (await heldPlayerIds(SEASON)).includes('p1'), true);
  const c = await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p2', side: 'buy', shares: 1, price: 4 });
  await cancelOrder({ owner: A, orderId: c.id });
  await rejects('cancelling twice fails', () => cancelOrder({ owner: A, orderId: c.id }), 'already');
  ok('nothing moved yet', await pointsFor(A, SEASON), 30);
}

console.log('\nfilling at a tick');
{
  // The tick prices p1 at 12, above the 10 the order was placed against: it
  // fills at the tick, not the tap.
  const r = await fillOrders({ p1: 12 }, { season: SEASON, now: Date.now() + 1000 });
  ok('one order filled', r.filled, 1);
  ok('two shares at ask 12.30 cost 25', await pointsFor(A, SEASON), 5);
  const h = await holdingsFor(A, SEASON);
  ok('holding recorded with its cost', h.map((x) => [x.player_id, x.shares, x.cost_points]), [['p1', 2, 25]]);
  const o = (await ordersFor(A, SEASON)).find((x) => x.player_id === 'p1' && x.side === 'buy');
  ok('the order shows its fill', [o.status, Number(o.price), o.points], ['filled', 12, -25]);

  // An order placed AFTER the tick waits for the next one.
  await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p1', side: 'sell', shares: 1, price: 12 });
  const early = await fillOrders({ p1: 12 }, { season: SEASON, now: Date.now() - 60_000 });
  ok('an order from after the tick is not filled by it', early.filled, 0);
  const r2 = await fillOrders({ p1: 20 }, { season: SEASON, now: Date.now() + 1000 });
  ok('the next tick fills the sell', r2.filled, 1);
  ok('one share at bid 19.50 pays 19', await pointsFor(A, SEASON), 24);
  const [h2] = await holdingsFor(A, SEASON);
  ok('one share left, half the basis gone', [h2.shares, h2.cost_points], [1, 12]);
  ok('a player nobody prices waits', (await fillOrders({}, { season: SEASON })).waiting, 0);
}

console.log('\nthe clocks do not have to agree');
{
  // placed_at comes from the DATABASE, `now` from the caller, and the two
  // machines are about a second apart. Without the grace window an order
  // placed in the same second as a tick -- the one somebody just tapped and is
  // watching for -- was silently skipped until the next tick a minute later.
  await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p8', side: 'buy', shares: 1, price: 2 });
  const same = await fillOrders({ p8: 2 }, { season: SEASON, now: Date.now() });
  ok('an order placed this instant still fills at this tick', same.filled, 1);
  // The guarantee that matters is untouched: a tick from BEFORE the order was
  // placed cannot fill it, so nobody trades on a play the feed has not seen.
  await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p8', side: 'sell', shares: 1, price: 2 });
  const past = await fillOrders({ p8: 2 }, { season: SEASON, now: Date.now() - 60_000 });
  ok('a tick from a minute ago still does not', past.filled, 0);

  // Leave the book as this block found it: the sell above is still pending and
  // the share still held, and both would be counted by the assertions below.
  const stray = (await ordersFor(A, SEASON)).find((o) => o.player_id === 'p8' && o.status === 'pending');
  if (stray) await cancelOrder({ owner: A, season: SEASON, orderId: stray.id });
  await sql`delete from market_holdings where season = ${SEASON} and player_id = 'p8'`;
  await sql`delete from market_orders where season = ${SEASON} and player_id = 'p8'`;
  await sql`delete from point_ledger where season = ${SEASON} and note like '%p8%'`;
}

console.log('\nfills that cannot happen');
{
  await placeOrder({ owner: A, season: SEASON, week: 2, playerId: 'p3', side: 'buy', shares: 1, price: 20 });
  // The price doubles before the tick; A has 24 and needs 41.
  const r = await fillOrders({ p3: 40 }, { season: SEASON, now: Date.now() + 1000 });
  ok('rejected at the tick when the points are not there', [r.filled, r.rejected], [0, 1]);
  const [o] = await ordersFor(A, SEASON);
  ok('and says why', o.status === 'rejected' && /needed 41/.test(o.note), true);
  ok('nothing charged', await pointsFor(A, SEASON), 24);
  const w = await fillOrders({ p9: 1 }, { season: SEASON });
  ok('no pending orders, nothing happens', w, { filled: 0, rejected: 0, waiting: 0 });
}

console.log('\ndividends at the roll');
{
  // A holds 1 share of p1. B buys 3 of p1 at 1 (cheap) to hold too.
  await sql`insert into point_ledger (bettor, season, week, amount, reason, note) values (${B}, ${SEASON}, null, 10, 'adjustment', 'test top-up')`;
  await placeOrder({ owner: B, season: SEASON, week: 2, playerId: 'p1', side: 'buy', shares: 3, price: 1 });
  await fillOrders({ p1: 1 }, { season: SEASON, now: Date.now() + 1000 });
  ok('B holds 3', (await holdingsFor(B, SEASON))[0].shares, 3);
  const before = { a: await pointsFor(A, SEASON), b: await pointsFor(B, SEASON) };
  // p1 scored 30 this week: 1.5 a share. A gets 1.5 -> 1; B gets 4.5 -> 4.
  const d = await payDividends({ season: SEASON, week: 2, actualFrom: { p1: 30, p3: 50 } });
  ok('both owners paid', d.paid, 2);
  ok('A rounds down to 1', (await pointsFor(A, SEASON)) - before.a, 1);
  ok('B rounds down to 4', (await pointsFor(B, SEASON)) - before.b, 4);
  const again = await payDividends({ season: SEASON, week: 2, actualFrom: { p1: 30 } });
  ok('a second roll pays nobody twice', again.paid, 0);
  ok('unchanged', (await pointsFor(B, SEASON)) - before.b, 4);
  const detail = await dividendsFor(B, SEASON);
  ok('the detail names the player and the points', detail.map((x) => [x.player_id, x.shares, Number(x.actual), Number(x.points)]), [['p1', 3, 30, 4.5]]);
  const none = await payDividends({ season: SEASON, week: 3, actualFrom: { p1: 0 } });
  ok('a goose egg pays nothing and writes nothing', none, { owners: 0, paid: 0, holdings: 0 });
}

await clean();
console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
