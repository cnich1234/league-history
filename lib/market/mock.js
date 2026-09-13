/**
 * A fake market, so the chart can be watched before the real feed is wired.
 *
 * Everything is DETERMINISTIC from the player's id and the clock. There is no
 * stored state: ask for a price at any instant and it is computed, so two
 * phones agree, a reload shows the same history, and the next minute brings a
 * new tick. The series advances with real time, which is what makes it feel
 * live on a Sunday afternoon.
 *
 * Two layers, the way real prices are usually modelled:
 *
 *   daily   a random walk of closes, one per (Eastern) day, with big steps on
 *           game days, small steps in the week, an occasional news jump, and a
 *           slow pull back toward the player's fundamental price
 *   minute  within each day, a noisy path that is bridged to land exactly on
 *           that day's close. Inside a game window the noise is several times
 *           louder and touchdowns arrive as jumps
 *
 * The bridge means the intraday path "knows" where it ends. Nobody watching a
 * chart can tell, and it keeps the two layers consistent: the 3M chart and the
 * 1D chart are the same numbers at different resolutions.
 */
const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** Days are Eastern: 1 June 2026, midnight EDT. Weekday of day 0 is Monday. */
export const EPOCH = Date.UTC(2026, 5, 1, 4);

export const dayIndex = (t) => Math.floor((t - EPOCH) / DAY);
export const dayStart = (d) => EPOCH + d * DAY;
export const minuteOfDay = (t) => Math.floor((t - dayStart(dayIndex(t))) / MINUTE);
const weekday = (d) => new Date(dayStart(d)).getUTCDay();

/**
 * When the games are on, in minutes from Eastern midnight. Sunday is the long
 * slate; Monday and Thursday are one night game.
 */
export function gameWindow(d) {
  const w = weekday(d);
  if (w === 0) return [13 * 60, 23 * 60 + 30];
  if (w === 1 || w === 4) return [20 * 60 + 15, 23 * 60 + 45];
  return null;
}

export function inGameWindow(t) {
  const win = gameWindow(dayIndex(t));
  if (!win) return false;
  const m = minuteOfDay(t);
  return m >= win[0] && m <= win[1];
}

/* ---------- deterministic randomness ---------- */

function hash(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = 1 - r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const r2 = (n) => Math.round(n * 100) / 100;

/* ---------- the daily layer ---------- */

const GAME_DAY_VOL = 0.05;
const QUIET_DAY_VOL = 0.012;
const PULL_TO_BASE = 0.04;
const NEWS_CHANCE = 0.03;

/**
 * closes[0] is the price before day 0; closes[d + 1] is the close of day d.
 * Cheap enough to regenerate every call: a season is a hundred steps.
 */
export function dailyCloses(key, base, throughDay) {
  const r = rng(hash(`${key}|daily`));
  const closes = [base];
  const logBase = Math.log(base);
  for (let d = 0; d <= throughDay; d++) {
    const prev = closes[d];
    const vol = gameWindow(d) ? GAME_DAY_VOL : QUIET_DAY_VOL;
    let ret = vol * gauss(r) + PULL_TO_BASE * (logBase - Math.log(prev));
    if (r() < NEWS_CHANCE) ret += (r() < 0.5 ? 1 : -1) * (0.06 + 0.1 * r());
    closes.push(Math.max(0.5, prev * Math.exp(ret)));
  }
  return closes;
}

/* ---------- the minute layer ---------- */

const MINUTES = 24 * 60;
const GAME_VOL = 0.0035;
const DAY_VOL = 0.0006;
const NIGHT_VOL = 0.0002;
const PLAY_CHANCE = 0.012;

const pathCache = new Map();

/**
 * One day of minute prices for a player, bridged to the daily close.
 * Returns { open, close, prices: Float32Array(1440), vol: Float32Array(1440) }.
 */
export function dayPath(key, base, d) {
  const ck = `${key}|${base}|${d}`;
  const hit = pathCache.get(ck);
  if (hit) return hit;

  const closes = dailyCloses(key, base, d);
  const open = closes[d];
  const close = closes[d + 1];
  const r = rng(hash(`${key}|day|${d}`));
  const win = gameWindow(d);

  const logs = new Float64Array(MINUTES);
  const vol = new Float32Array(MINUTES);
  // Cumulative variance, so the bridge below corrects the path where it was
  // noisy. Spreading the correction evenly across the clock put a steady
  // slope through the quiet morning of a game day, which read as a stock
  // bleeding for no reason.
  const cum = new Float64Array(MINUTES);
  let x = Math.log(open);
  let variance = 0;
  for (let m = 0; m < MINUTES; m++) {
    const live = win && m >= win[0] && m <= win[1];
    const sigma = live ? GAME_VOL : m < 6 * 60 || m > 23 * 60 ? NIGHT_VOL : DAY_VOL;
    let step = sigma * gauss(r);
    // A touchdown, or a fumble. Scores are more common than turnovers.
    if (live && r() < PLAY_CHANCE) step += (r() < 0.62 ? 1 : -1) * (0.015 + 0.05 * r());
    x += step;
    logs[m] = x;
    vol[m] = (live ? 8 : 1) * (0.5 + r());
    variance += sigma * sigma + (live ? PLAY_CHANCE * 0.045 * 0.045 : 0);
    cum[m] = variance;
  }
  // Slide the path so it ends on the day's close, in proportion to how much
  // of the day's noise has happened by each minute.
  const drift = Math.log(close) - logs[MINUTES - 1];
  const total = cum[MINUTES - 1] || 1;
  const prices = new Float32Array(MINUTES);
  for (let m = 0; m < MINUTES; m++) prices[m] = Math.exp(logs[m] + drift * (cum[m] / total));

  const out = { open, close, prices, vol };
  if (pathCache.size > 4000) pathCache.clear();
  pathCache.set(ck, out);
  return out;
}

/* ---------- what the pages ask for ---------- */

/** The price at the minute containing `t`; the base before the epoch. */
export function priceAt(key, base, t) {
  const d = dayIndex(t);
  if (d < 0) return base;
  return dayPath(key, base, d).prices[minuteOfDay(t)];
}

/**
 * Where the player trades right now, against 24 hours ago.
 *
 * This market never closes, so "the day" is the last 24 hours rather than a
 * session -- the way crypto is quoted. A session from Eastern midnight looked
 * wrong in Arizona, where it started at nine the previous evening.
 */
export function mockQuote(key, base, now = Date.now()) {
  const last = Math.floor(now / MINUTE) * MINUTE;
  const ago = last - DAY;
  const price = priceAt(key, base, last);
  const prevClose = priceAt(key, base, ago);
  let hi = -Infinity;
  let lo = Infinity;
  for (let ms = ago; ms <= last; ms += MINUTE) {
    const p = priceAt(key, base, ms);
    if (p > hi) hi = p;
    if (p < lo) lo = p;
  }
  return {
    price: r2(price),
    prevClose: r2(prevClose),
    dayOpen: r2(prevClose),
    dayHigh: r2(hi),
    dayLow: r2(lo),
    change: r2(price - prevClose),
    changePct: r2((price / prevClose - 1) * 100),
    inGame: inGameWindow(now),
  };
}

/**
 * Candles of `step` ms between `from` and `to` (inclusive of the minute `to`
 * falls in, so the last candle's close is the quote's price). Buckets are
 * aligned to the Eastern epoch, so a daily candle is an Eastern day.
 */
export function mockCandles(key, base, from, to, step) {
  const out = [];
  const last = Math.floor(to / MINUTE) * MINUTE;
  const first = EPOCH + Math.floor((from - EPOCH) / step) * step;
  for (let t = first; t <= last; t += step) {
    const end = Math.min(t + step - MINUTE, last);
    let o = 0;
    let h = -Infinity;
    let l = Infinity;
    let c = 0;
    let v = 0;
    let any = false;
    for (let ms = Math.max(t, Math.floor(from / MINUTE) * MINUTE); ms <= end; ms += MINUTE) {
      const d = dayIndex(ms);
      if (d < 0) continue;
      const day = dayPath(key, base, d);
      const p = day.prices[minuteOfDay(ms)];
      if (!any) {
        o = p;
        any = true;
      }
      if (p > h) h = p;
      if (p < l) l = p;
      c = p;
      v += day.vol[minuteOfDay(ms)];
    }
    if (any) out.push({ t, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: Math.round(v) });
  }
  return out;
}
