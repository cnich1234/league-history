/**
 * The two places a price can come from.
 *
 *   live   the default. Real players, real prices from this week's projection
 *          and the Sleeper stat line, repriced while a game is on. History is
 *          whatever the tick log has recorded, which starts the first time the
 *          board is loaded.
 *   mock   real players, invented prices that move with the clock. For
 *          watching the chart with ninety days of history behind it.
 *
 * Both return the same shapes, so the pages do not care which they got.
 */
import { actualPoints } from '@/lib/dfs';
import { loadUniverse, nflState } from './universe.js';
import { mockQuote, mockCandles, DAY } from './mock.js';
import { basePrice, livePrice, gameRemaining, gameLive } from './price.js';
import { rangeWindow, toCandles, DEFAULT_RANGE, RANGES } from './candles.js';
import { recordTick, seriesFor, trackFor, TICK_EVERY_MS, QUIET_EVERY_MS } from './ticks.js';
import { premiums } from './baselines.js';
import { explainTrack } from './why.js';
import {
  heldPlayerIds,
  fillOrders,
  pendingCount,
  holdingsFor,
  ordersFor,
  dividendsFor,
  pointsFor,
  quoteFor,
  MAX_SHARES,
  SPREAD,
} from './trading.js';

export const SOURCES = ['live', 'mock'];
export const normaliseSource = (s) => (s === 'mock' ? 'mock' : 'live');

const r2 = (n) => Math.round(n * 100) / 100;

/** Per-team game state, so a player's `remaining` can be read off his team. */
async function gamesByTeam(season, week) {
  const res = await fetch(`https://api.sleeper.com/scores/nfl/regular/${season}/${week}`);
  if (!res.ok) return {};
  const rows = await res.json();
  const byTeam = {};
  for (const g of Array.isArray(rows) ? rows : Object.values(rows)) {
    const m = g.metadata ?? {};
    if (m.home_team) byTeam[m.home_team] = g;
    if (m.away_team) byTeam[m.away_team] = g;
  }
  return byTeam;
}

/*
 * The stat line and game state are fetched at most every twenty seconds per
 * instance: a dozen phones polling every half minute must not turn into a
 * dozen pulls of every player's stats.
 */
const FEED_TTL = 20_000;
let feed = { at: 0, promise: null };

function liveContext() {
  if (feed.promise && Date.now() - feed.at < FEED_TTL) return feed.promise;
  feed = {
    at: Date.now(),
    promise: (async () => {
      const { season, week } = await nflState();
      // Anyone somebody holds keeps a price, even outside the top 150.
      const include = await heldPlayerIds(season).catch(() => []);
      const [universe, points, games, carried] = await Promise.all([
        loadUniverse({ season, week, include }),
        actualPoints(season, week).catch(() => ({})),
        gamesByTeam(season, week).catch(() => ({})),
        premiums(season, week).catch(() => new Map()),
      ]);
      return { season, week, universe, points, games, carried };
    })(),
  };
  feed.promise.catch(() => {
    feed = { at: 0, promise: null };
  });
  return feed.promise;
}

function liveRow(p, { points, games, carried }) {
  const game = p.team ? games[p.team] : null;
  const remaining = game ? gameRemaining(game) : 1;
  const pts = Number(points[p.id]) || 0;
  const carry = carried?.get(String(p.id));
  const premium = carry?.premium ?? 0;
  const price = livePrice({ projection: p.projection, points: pts, remaining, premium });
  const prevClose = basePrice(p.projection, premium);
  return {
    ...p,
    price,
    prevClose,
    dayOpen: prevClose,
    dayHigh: Math.max(price, prevClose),
    dayLow: Math.min(price, prevClose),
    change: r2(price - prevClose),
    changePct: r2((price / prevClose - 1) * 100),
    inGame: gameLive(game),
    points: pts,
    remaining,
    premium,
    dividend: carry?.dividend ?? null,
    lastActual: carry?.prevActual ?? null,
    status: !game ? 'none' : gameLive(game) ? 'live' : remaining === 0 ? 'final' : 'pre',
  };
}

/**
 * Every live row, and a tick logged if the log is stale: a minute apart while
 * any game is on or any order is waiting, a quarter hour otherwise. Pass
 * `{ tick: true }` to insist on the minute gap -- the trade route does, so an
 * order placed on a quiet Tuesday fills against a fresh tick right away
 * rather than waiting for the quarter-hour.
 */
async function liveBoard(now, { tick = false } = {}) {
  const ctx = await liveContext();
  const rows = ctx.universe.map((p) => liveRow(p, ctx));
  const anyLive = rows.some((r) => r.inGame);
  const waiting = tick ? 1 : await pendingCount(ctx.season).catch(() => 0);
  // A failed write must never take the board down with it.
  const wrote = await recordTick(rows, now, {
    gap: anyLive || waiting > 0 ? TICK_EVERY_MS : QUIET_EVERY_MS,
  }).catch(() => false);
  // Orders fill at recorded ticks and only there: the price a fill gets is
  // the price the log shows, so every fill is auditable against the chart.
  let fills = null;
  if (wrote) {
    const prices = Object.fromEntries(rows.map((r) => [String(r.id), r.price]));
    const names = Object.fromEntries(rows.map((r) => [String(r.id), r.ticker]));
    fills = await fillOrders(prices, { season: ctx.season, now, names }).catch((e) => ({ error: e.message }));
  }
  return { ...ctx, rows, wrote, anyLive, fills };
}

/** What one owner holds, is waiting on, and has collected. */
export async function portfolio(owner, now = Date.now()) {
  const board = await liveBoard(now);
  const byId = new Map(board.rows.map((r) => [String(r.id), r]));
  const [holdings, orders, dividends, points] = await Promise.all([
    holdingsFor(owner, board.season),
    ordersFor(owner, board.season),
    dividendsFor(owner, board.season),
    pointsFor(owner, board.season),
  ]);
  const positions = holdings.map((h) => {
    const row = byId.get(String(h.player_id));
    const price = row?.price ?? 0;
    const { bid } = quoteFor(price);
    const value = r2(bid * h.shares);
    return {
      playerId: String(h.player_id),
      ticker: row?.ticker ?? '?',
      name: row?.name ?? h.player_id,
      position: row?.position ?? null,
      team: row?.team ?? null,
      photo: row?.photo ?? null,
      inGame: Boolean(row?.inGame),
      shares: Number(h.shares),
      cost: Number(h.cost_points),
      price,
      bid,
      value,
      gain: r2(value - Number(h.cost_points)),
      changePct: row?.changePct ?? 0,
    };
  });
  const dividendTotal = r2(dividends.reduce((s, d) => s + Number(d.points), 0));
  return {
    asOf: now,
    season: board.season,
    week: board.week,
    points,
    positions: positions.sort((a, b) => b.value - a.value),
    value: r2(positions.reduce((s, p) => s + p.value, 0)),
    cost: positions.reduce((s, p) => s + p.cost, 0),
    orders: orders.map((o) => ({ ...o, ticker: byId.get(String(o.player_id))?.ticker ?? o.player_id, name: byId.get(String(o.player_id))?.name ?? o.player_id })),
    dividends: dividends.map((d) => ({ ...d, ticker: byId.get(String(d.player_id))?.ticker ?? d.player_id, name: byId.get(String(d.player_id))?.name ?? d.player_id })),
    dividendTotal,
    rules: { spread: SPREAD, maxShares: MAX_SHARES },
  };
}

/** After an order is placed: tick now if the log allows it, and fill. */
export async function fillNow(now = Date.now()) {
  const board = await liveBoard(now, { tick: true });
  return { wrote: board.wrote, fills: board.fills };
}

/** For the cron: take a snapshot and say what happened. */
export async function snapshot(now = Date.now()) {
  const board = await liveBoard(now);
  return {
    wrote: board.wrote,
    live: board.rows.filter((r) => r.inGame).length,
    rows: board.rows.length,
    season: board.season,
    week: board.week,
  };
}

/** A player's recorded moves with reasons, plus the raw track. */
export async function explain({ ticker, range = DEFAULT_RANGE, now = Date.now() }) {
  const rng = RANGES[range] ? range : DEFAULT_RANGE;
  const { from } = rangeWindow(rng, now);
  const board = await liveBoard(now);
  const player = board.rows.find((u) => u.ticker === String(ticker ?? '').toUpperCase());
  if (!player) return null;
  const track = await trackFor(player.id, from, now);
  return { player, range: rng, track, moves: explainTrack(track) };
}

function mockRow(p, now) {
  const q = mockQuote(p.id, basePrice(p.projection), now);
  return { ...p, ...q };
}

/** Shares `owner` holds, by player id, for badging rows. */
async function ownedBy(owner, season) {
  if (!owner) return {};
  const rows = await holdingsFor(owner, season).catch(() => []);
  return Object.fromEntries(rows.map((h) => [String(h.player_id), Number(h.shares)]));
}

/** Every stock with its current quote. `owner` adds how many shares they hold. */
export async function quotes({ source = 'live', owner = null, now = Date.now() } = {}) {
  const src = normaliseSource(source);
  if (src === 'live') {
    const board = await liveBoard(now);
    const owned = await ownedBy(owner, board.season);
    const rows = board.rows.map((r) => ({ ...r, owned: owned[String(r.id)] ?? 0 }));
    return { source: src, asOf: now, season: board.season, week: board.week, rows };
  }
  const { season, week } = await nflState();
  const universe = await loadUniverse({ season, week });
  return { source: src, asOf: now, season, week, rows: universe.map((p) => mockRow(p, now)) };
}

/** One stock: quote plus candles for a range. Null when the ticker is unknown. */
export async function history({ source = 'live', ticker, range = DEFAULT_RANGE, owner = null, now = Date.now() }) {
  const src = normaliseSource(source);
  const rng = RANGES[range] ? range : DEFAULT_RANGE;
  const sym = String(ticker ?? '').toUpperCase();
  const { from, to, step } = rangeWindow(rng, now);

  if (src === 'live') {
    const board = await liveBoard(now);
    const found = board.rows.find((u) => u.ticker === sym);
    if (!found) return null;
    const owned = await ownedBy(owner, board.season);
    const player = {
      ...found,
      ...quoteFor(found.price),
      owned: owned[String(found.id)] ?? 0,
      balance: owner ? await pointsFor(owner, board.season).catch(() => null) : null,
      maxShares: MAX_SHARES,
      spread: SPREAD,
    };
    // The log, plus this instant, so the last candle is the quote.
    const series = await seriesFor(player.id, Math.min(from, now - DAY), now).catch(() => []);
    const recent = series.filter((s) => s.t >= now - DAY).map((s) => s.price);
    const candles = toCandles(
      [...series.filter((s) => s.t >= from), { t: now, price: player.price }],
      step,
    );
    return {
      source: src,
      asOf: now,
      range: rng,
      player: {
        ...player,
        dayHigh: r2(Math.max(player.price, ...recent)),
        dayLow: r2(Math.min(player.price, ...recent)),
      },
      candles,
      note:
        candles.length > 1
          ? null
          : 'Real prices. The chart fills in as ticks are logged, from now on.',
    };
  }

  const { season, week } = await nflState();
  const universe = await loadUniverse({ season, week });
  const p = universe.find((u) => u.ticker === sym);
  if (!p) return null;
  return {
    source: src,
    asOf: now,
    range: rng,
    player: mockRow(p, now),
    candles: mockCandles(p.id, basePrice(p.projection), from, to, step),
  };
}
