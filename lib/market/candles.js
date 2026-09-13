/**
 * Chart ranges and candle bucketing.
 *
 * A range is how far back to look and how wide each candle is; the widths are
 * chosen so every range draws a hundred to three hundred candles, which is
 * what reads well on a phone. Every range is a rolling window ending now:
 * the market never closes, so there is no session for 1D to be.
 */
import { DAY, EPOCH } from './mock.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RANGES = {
  '1D': { days: 1, step: 5 * MINUTE },
  '1W': { days: 7, step: HOUR },
  '2W': { days: 14, step: 2 * HOUR },
  '1M': { days: 30, step: 6 * HOUR },
  '2M': { days: 60, step: 12 * HOUR },
  '3M': { days: 90, step: DAY },
};
export const RANGE_KEYS = Object.keys(RANGES);
export const DEFAULT_RANGE = '1D';

export function rangeWindow(range, now = Date.now()) {
  const def = RANGES[range] ?? RANGES[DEFAULT_RANGE];
  return { from: Math.max(now - def.days * DAY, EPOCH), to: now, step: def.step };
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
