/**
 * The tick log: the live source's memory.
 *
 * Prices are computed on demand from the feed, so nothing here is needed to
 * quote a stock. What the feed cannot give back is yesterday, and a chart is
 * nothing but yesterdays. So whenever the live board is loaded and the newest
 * row is more than a minute old, one row is written holding every price at
 * that moment. On a Sunday somebody is always looking.
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

// The newest row this instance knows about, to skip the query most of the
// time. Another instance may have written since; the query below settles it.
let newest = 0;

/**
 * Writes a snapshot if the log is stale. Returns true when a row was written.
 * @param rows  [{ id, price }] for every stock
 */
export async function recordTick(rows, now = Date.now()) {
  if (now - newest < TICK_EVERY_MS) return false;
  const [latest] = await sql`
    select extract(epoch from ts) * 1000 as ms from market_ticks order by ts desc limit 1`;
  if (latest) newest = Number(latest.ms);
  if (now - newest < TICK_EVERY_MS) return false;

  const prices = {};
  for (const r of rows) if (r?.id != null && Number.isFinite(r.price)) prices[r.id] = r.price;
  if (!Object.keys(prices).length) return false;

  await sql`
    insert into market_ticks (ts, prices)
    values (to_timestamp(${now / 1000}), ${JSON.stringify(prices)}::jsonb)`;
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

/** How many rows the log holds and when the newest was written. */
export async function tickStats() {
  const [row] = await sql`
    select count(*)::int as rows, extract(epoch from max(ts)) * 1000 as newest from market_ticks`;
  return { rows: row?.rows ?? 0, newest: row?.newest ? Number(row.newest) : null };
}
