/**
 * The tick log: the live source's memory.
 *
 * Prices are computed on demand from the feed, so nothing here is needed to
 * quote a stock. What the feed cannot give back is yesterday, and a chart is
 * nothing but yesterdays. A row is written when the newest is older than the
 * gap asked for: a minute during games, longer when nothing is on.
 *
 * Each row also keeps the INPUTS the prices were computed from -- points,
 * share of game left, projection, status, carried premium -- so any move can be explained
 * afterwards by diffing two rows. See why.js.
 *
 * Own connection, like every other module here: The Market shares nothing it
 * does not have to.
 */
import { neon } from '@neondatabase/serverless';

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

export const TICK_EVERY_MS = 60_000;
/** Between games the drift is slow; a tick a quarter hour keeps the chart honest cheaply. */
export const QUIET_EVERY_MS = 15 * 60_000;

// The newest row this instance knows about, to skip the query most of the
// time. Another instance may have written since; the query below settles it.
let newest = 0;

/**
 * Writes a snapshot if the log is older than `gap`. Returns true when a row
 * was written.
 * @param rows  [{ id, price, points, remaining, projection, status, premium }]
 */
export async function recordTick(rows, now = Date.now(), { gap = TICK_EVERY_MS } = {}) {
  if (now - newest < gap) return false;
  const [latest] = await sql`
    select extract(epoch from ts) * 1000 as ms from market_ticks order by ts desc limit 1`;
  if (latest) newest = Number(latest.ms);
  if (now - newest < gap) return false;

  const prices = {};
  const inputs = {};
  for (const r of rows) {
    if (r?.id == null || !Number.isFinite(r.price)) continue;
    prices[r.id] = r.price;
    inputs[r.id] = [
      Number(r.points) || 0,
      Number(r.remaining ?? 1),
      Number(r.projection) || 0,
      r.status ?? 'none',
      Number(r.premium) || 0,
    ];
  }
  if (!Object.keys(prices).length) return false;

  await sql`
    insert into market_ticks (ts, prices, inputs)
    values (to_timestamp(${now / 1000}), ${JSON.stringify(prices)}::jsonb, ${JSON.stringify(inputs)}::jsonb)`;
  newest = now;
  return true;
}

/** One player's recorded prices between two instants: [{ t, price }]. */
export async function seriesFor(playerId, from, to) {
  const rows = await sql`
    select extract(epoch from ts) * 1000 as ms, prices ->> ${String(playerId)} as price
    from market_ticks
    where ts >= to_timestamp(${from / 1000}) and ts <= to_timestamp(${to / 1000})
    order by ts`;
  return rows
    .filter((r) => r.price != null)
    .map((r) => ({ t: Number(r.ms), price: Number(r.price) }));
}

/**
 * Every player's price at one instant: the first tick at or after `at`.
 *
 * One query for the whole board, because the watchlist needs an opening price
 * for 150 rows and 150 round trips is not a way to draw a list. Returns a plain
 * object of player id to price, empty when nothing has been logged yet.
 */
export async function pricesAt(at) {
  const [row] = await sql`
    select prices from market_ticks
    where ts >= to_timestamp(${at / 1000}) order by ts limit 1`;
  return row?.prices ?? {};
}

/**
 * One player's prices WITH the inputs behind them:
 * [{ t, price, points, remaining, projection, status, premium }]. Rows from before
 * inputs were recorded carry nulls, and why.js says so rather than guessing.
 */
export async function trackFor(playerId, from, to) {
  const rows = await sql`
    select extract(epoch from ts) * 1000 as ms,
           prices ->> ${String(playerId)} as price,
           inputs -> ${String(playerId)} as inputs
    from market_ticks
    where ts >= to_timestamp(${from / 1000}) and ts <= to_timestamp(${to / 1000})
    order by ts`;
  return rows
    .filter((r) => r.price != null)
    .map((r) => {
      const i = Array.isArray(r.inputs) ? r.inputs : null;
      return {
        t: Number(r.ms),
        price: Number(r.price),
        points: i ? Number(i[0]) : null,
        remaining: i ? Number(i[1]) : null,
        projection: i ? Number(i[2]) : null,
        status: i ? String(i[3]) : null,
        premium: i && i.length > 4 ? Number(i[4]) : null,
      };
    });
}

/** How many rows the log holds and when the newest was written. */
export async function tickStats() {
  const [row] = await sql`
    select count(*)::int as rows, extract(epoch from max(ts)) * 1000 as newest,
           pg_total_relation_size('market_ticks') as bytes
    from market_ticks`;
  return {
    rows: row?.rows ?? 0,
    newest: row?.newest ? Number(row.newest) : null,
    bytes: Number(row?.bytes ?? 0),
  };
}
