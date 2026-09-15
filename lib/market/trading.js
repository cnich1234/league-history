/**
 * Buying and selling shares.
 *
 * The rules, all of which are enforced here and nowhere else:
 *
 *   spread    5%: a buy fills at the ask (price x 1.025), a sell at the bid
 *             (price x 0.975). The gap is the points sink that keeps the
 *             Market from printing points.
 *   whole     the points ledger is integers. A buy costs the ask rounded UP,
 *             a sell pays the bid rounded DOWN. Shares are whole too.
 *   cap       at most MAX_SHARES of one player per owner, counting what is
 *             already pending.
 *   fills     an order never fills on the tap. It queues and fills at the
 *             next recorded tick, so nobody trades on a touchdown before the
 *             feed sees it. Cancel while it is still pending.
 *   dividends 5% of a player's weekly points per share, paid at the roll, one
 *             ledger row per owner per week, rounded down.
 *
 * Points move through the same ledger the shop spends from, so a good trade
 * buys boosts and a bad one costs attacks. Own connection, like every other
 * module here.
 */
import { neon } from '@neondatabase/serverless';
import { dividendFor } from './price.js';

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

export const SPREAD = 0.05;
export const MAX_SHARES = 10;

const r2 = (n) => Math.round(n * 100) / 100;

/** Bid and ask around a model price. */
export function quoteFor(price) {
  const p = Number(price) || 0;
  return { bid: r2(p * (1 - SPREAD / 2)), ask: r2(p * (1 + SPREAD / 2)) };
}

/** What `shares` cost to buy, or pay to sell, in whole points. */
export function costToBuy(price, shares) {
  return Math.ceil(quoteFor(price).ask * shares - 1e-9);
}
export function proceedsToSell(price, shares) {
  return Math.floor(quoteFor(price).bid * shares + 1e-9);
}

/** Spendable points, this season, from the same ledger the shop reads. */
export async function pointsFor(owner, season) {
  const [row] = await sql`
    select coalesce(sum(amount), 0)::int as points
    from point_ledger where bettor = ${owner} and season = ${season}`;
  return Number(row?.points ?? 0);
}

export async function holdingsFor(owner, season) {
  return sql`
    select player_id, shares, cost_points from market_holdings
    where owner = ${owner} and season = ${season} and shares > 0`;
}

/** Every player anybody holds this season, so each one keeps a price. */
export async function heldPlayerIds(season) {
  const rows = await sql`
    select distinct player_id from market_holdings where season = ${season} and shares > 0
    union
    select distinct player_id from market_orders where season = ${season} and status = 'pending'`;
  return rows.map((r) => String(r.player_id));
}

export async function ordersFor(owner, season, { limit = 50 } = {}) {
  return sql`
    select id, week, player_id, side, shares, status, placed_at, filled_at, price, points, note
    from market_orders where owner = ${owner} and season = ${season}
    order by placed_at desc limit ${limit}`;
}

async function pendingFor(owner, season, playerId) {
  const rows = await sql`
    select side, coalesce(sum(shares), 0)::int as shares from market_orders
    where owner = ${owner} and season = ${season} and player_id = ${playerId} and status = 'pending'
    group by side`;
  const out = { buy: 0, sell: 0 };
  for (const r of rows) out[r.side] = Number(r.shares);
  return out;
}

async function heldShares(owner, season, playerId) {
  const [row] = await sql`
    select shares from market_holdings
    where owner = ${owner} and season = ${season} and player_id = ${playerId}`;
  return Number(row?.shares ?? 0);
}

/**
 * Queues an order. `price` is the model price right now, used only to check
 * the buyer can plausibly afford it; the fill uses the next tick's price.
 */
export async function placeOrder({ owner, season, week, playerId, side, shares, price }) {
  const n = Number(shares);
  if (!Number.isInteger(n) || n < 1) throw new Error('Shares must be a whole number, at least 1.');
  if (side !== 'buy' && side !== 'sell') throw new Error('Buy or sell.');
  const id = String(playerId);
  const held = await heldShares(owner, season, id);
  const pending = await pendingFor(owner, season, id);

  if (side === 'buy') {
    if (held + pending.buy + n > MAX_SHARES) {
      throw new Error(`You can hold at most ${MAX_SHARES} shares of one player (you have ${held}${pending.buy ? `, ${pending.buy} pending` : ''}).`);
    }
    const cost = costToBuy(price, n);
    const points = await pointsFor(owner, season);
    if (points < cost) throw new Error(`That costs about ${cost} points and you have ${points}.`);
  } else {
    if (held - pending.sell < n) {
      throw new Error(`You have ${held} share${held === 1 ? '' : 's'} to sell${pending.sell ? ` (${pending.sell} already pending)` : ''}.`);
    }
  }

  const [order] = await sql`
    insert into market_orders (owner, season, week, player_id, side, shares)
    values (${owner}, ${season}, ${week}, ${id}, ${side}, ${n})
    returning id, side, shares, status, placed_at`;
  return order;
}

/** Cancels a pending order. Anything already filling is too late. */
export async function cancelOrder({ owner, orderId }) {
  const [row] = await sql`
    update market_orders set status = 'cancelled', note = 'cancelled by owner'
    where id = ${orderId} and owner = ${owner} and status = 'pending'
    returning id`;
  if (!row) throw new Error('That order has already filled or been cancelled.');
  return row;
}

/**
 * Fills every pending order at a tick's prices. Called once per recorded tick.
 * `prices` is { player_id: price }. Orders placed after the tick wait for the
 * next one; an order whose player has no price in this tick waits too.
 *
 * Each order is claimed ('filling') before any money moves, so two fillers
 * running at once cannot both pay the same order.
 */
export async function fillOrders(prices, { season, now = Date.now() } = {}) {
  const tickAt = new Date(now);
  const pending = await sql`
    select id, owner, season, week, player_id, side, shares from market_orders
    where status = 'pending' and season = ${season} and placed_at <= ${tickAt}
    order by placed_at, id`;
  const out = { filled: 0, rejected: 0, waiting: 0 };

  for (const o of pending) {
    const price = Number(prices[o.player_id]);
    if (!Number.isFinite(price) || price <= 0) {
      out.waiting++;
      continue;
    }
    const [claimed] = await sql`
      update market_orders set status = 'filling' where id = ${o.id} and status = 'pending' returning id`;
    if (!claimed) continue;

    const reject = async (why) => {
      await sql`update market_orders set status = 'rejected', note = ${why}, filled_at = ${tickAt} where id = ${o.id}`;
      out.rejected++;
    };

    const held = await heldShares(o.owner, o.season, o.player_id);
    if (o.side === 'buy') {
      const cost = costToBuy(price, o.shares);
      if (held + o.shares > MAX_SHARES) {
        await reject(`would exceed ${MAX_SHARES} shares`);
        continue;
      }
      const points = await pointsFor(o.owner, o.season);
      if (points < cost) {
        await reject(`needed ${cost} points, had ${points}`);
        continue;
      }
      await sql`
        insert into point_ledger (bettor, season, week, amount, reason, note)
        values (${o.owner}, ${o.season}, ${o.week}, ${-cost}, 'trade', ${`bought ${o.shares} x ${o.player_id} @ ${price}`})`;
      await sql`
        insert into market_holdings (owner, season, player_id, shares, cost_points)
        values (${o.owner}, ${o.season}, ${o.player_id}, ${o.shares}, ${cost})
        on conflict (owner, season, player_id) do update
          set shares = market_holdings.shares + ${o.shares},
              cost_points = market_holdings.cost_points + ${cost},
              updated_at = now()`;
      await sql`
        update market_orders set status = 'filled', filled_at = ${tickAt}, price = ${price}, points = ${-cost}
        where id = ${o.id}`;
      out.filled++;
    } else {
      if (held < o.shares) {
        await reject(`only ${held} share(s) held`);
        continue;
      }
      const proceeds = proceedsToSell(price, o.shares);
      const [h] = await sql`
        select cost_points from market_holdings where owner = ${o.owner} and season = ${o.season} and player_id = ${o.player_id}`;
      // The cost basis leaves in proportion to the shares sold.
      const basisOut = Math.round((Number(h?.cost_points ?? 0) * o.shares) / held);
      await sql`
        insert into point_ledger (bettor, season, week, amount, reason, note)
        values (${o.owner}, ${o.season}, ${o.week}, ${proceeds}, 'trade', ${`sold ${o.shares} x ${o.player_id} @ ${price}`})`;
      await sql`
        update market_holdings
          set shares = shares - ${o.shares}, cost_points = greatest(0, cost_points - ${basisOut}), updated_at = now()
        where owner = ${o.owner} and season = ${o.season} and player_id = ${o.player_id}`;
      await sql`
        update market_orders set status = 'filled', filled_at = ${tickAt}, price = ${price}, points = ${proceeds}
        where id = ${o.id}`;
      out.filled++;
    }
  }
  return out;
}

/**
 * Pays the week's dividends: shares held x 5% of the player's points, summed
 * per owner and rounded down to whole points. Once per owner per week, kept
 * honest by point_ledger_dividend_once; the per-player detail goes to
 * market_dividends. Holdings are read as they stand at the roll.
 */
export async function payDividends({ season, week, actualFrom }) {
  const holdings = await sql`
    select owner, player_id, shares from market_holdings where season = ${season} and shares > 0`;
  const perOwner = new Map();
  const detail = [];
  for (const h of holdings) {
    const actual = Number(actualFrom[h.player_id]) || 0;
    const points = r2(dividendFor(actual) * h.shares);
    if (points <= 0) continue;
    detail.push({ ...h, actual, points });
    perOwner.set(h.owner, (perOwner.get(h.owner) ?? 0) + points);
  }
  let paid = 0;
  for (const [owner, total] of perOwner) {
    const whole = Math.floor(total + 1e-9);
    if (whole <= 0) continue;
    const rows = await sql`
      insert into point_ledger (bettor, season, week, amount, reason, note)
      values (${owner}, ${season}, ${week}, ${whole}, 'dividend', ${`Week ${week} dividends`})
      on conflict do nothing returning id`;
    if (rows.length) paid++;
  }
  if (detail.length) {
    await sql`
      insert into market_dividends (owner, season, week, player_id, shares, actual, points)
      select owner, ${season}, ${week}, player_id, shares, actual, points from unnest(
        ${detail.map((d) => d.owner)}::text[], ${detail.map((d) => d.player_id)}::text[],
        ${detail.map((d) => d.shares)}::int[], ${detail.map((d) => d.actual)}::numeric[],
        ${detail.map((d) => d.points)}::numeric[]
      ) as t(owner, player_id, shares, actual, points)
      on conflict do nothing`;
  }
  return { owners: perOwner.size, paid, holdings: detail.length };
}

/** Dividends an owner has collected this season, by player. */
export async function dividendsFor(owner, season) {
  return sql`
    select week, player_id, shares, actual, points from market_dividends
    where owner = ${owner} and season = ${season} order by week desc, points desc`;
}
