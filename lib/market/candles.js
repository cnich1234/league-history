/**
 * Chart ranges and candle bucketing.
 *
 * A range is how far back to look and how wide each candle is; the widths are
 * chosen so every range draws a hundred to three hundred candles, which is
 * what reads well on a phone.
 *
 * Most ranges are rolling windows ending now -- the market never closes, so
 * there is no session for 1D to be. WEEK is the exception and the default,
 * because this market does have a session: prices reset at the Tuesday roll,
 * dividends pay there, and "what has happened since the week began" is the
 * question anyone actually has. A rolling 24 hours answered a different one
 * and silently dropped Tuesday's moves by Wednesday afternoon, which is how
 * a real price change came to look like it had been erased.
 */
import { DAY, EPOCH } from './mock.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RANGES = {
  // Anchored to the roll rather than to the clock. `days` is only the fallback
  // width for a week that has not rolled (week 1), and the cap on how far back
  // the window can reach if a roll timestamp is somehow missing.
  WEEK: { days: 7, step: 15 * MINUTE, anchored: true, label: 'This week' },
  '1D': { days: 1, step: 5 * MINUTE },
  '1W': { days: 7, step: HOUR },
  '2W': { days: 14, step: 2 * HOUR },
  '1M': { days: 30, step: 6 * HOUR },
  '2M': { days: 60, step: 12 * HOUR },
  '3M': { days: 90, step: DAY },
};
export const RANGE_KEYS = Object.keys(RANGES);
export const DEFAULT_RANGE = 'WEEK';

/**
 * The window a range covers.
 *
 * `weekStartMs` is when the current week rolled, and it is what makes WEEK an
 * anchored range rather than a rolling one. Pass null (or nothing) and WEEK
 * degrades to its rolling seven days, which is the right answer in week 1 when
 * no roll has happened yet.
 */
export function rangeWindow(range, now = Date.now(), weekStartMs = null) {
  const def = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  const floor = Math.max(now - def.days * DAY, EPOCH);
  if (def.anchored && weekStartMs) {
    // A little before the roll, so the tick that did the repricing is inside
    // the window and the move that opened the week can be explained rather
    // than being the first point on the chart with nothing to diff against.
    const from = Math.max(weekStartMs - 5 * MINUTE, EPOCH);
    return { from: Math.max(from, floor), to: now, step: def.step };
  }
  return { from: floor, to: now, step: def.step };
}

/**
 * Buckets recorded ticks [{ t, price, volume }] into candles. This is what the
 * live source will use once ticks are being logged; the mock builds its own
 * candles because it can see every minute for free.
 */
export function toCandles(ticks, step) {
  const out = [];
  let cur = null;
  for (const tick of [...ticks].sort((a, b) => a.t - b.t)) {
    const t = EPOCH + Math.floor((tick.t - EPOCH) / step) * step;
    if (!cur || cur.t !== t) {
      if (cur) out.push(cur);
      cur = { t, o: tick.price, h: tick.price, l: tick.price, c: tick.price, v: 0 };
    }
    cur.h = Math.max(cur.h, tick.price);
    cur.l = Math.min(cur.l, tick.price);
    cur.c = tick.price;
    cur.v += tick.volume ?? 0;
  }
  if (cur) out.push(cur);
  return out;
}
