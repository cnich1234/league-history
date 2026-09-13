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
import { recordTick, seriesFor } from './ticks.js';

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
      const [universe, points, games] = await Promise.all([
        loadUniverse({ season, week }),
        actualPoints(season, week).catch(() => ({})),
        gamesByTeam(season, week).catch(() => ({})),
      ]);
      return { season, week, universe, points, games };
    })(),
  };
  feed.promise.catch(() => {
    feed = { at: 0, promise: null };
  });
  return feed.promise;
}

function liveRow(p, { points, games }) {
  const game = p.team ? games[p.team] : null;
  const remaining = game ? gameRemaining(game) : 1;
  const pts = Number(points[p.id]) || 0;
  const price = livePrice({ projection: p.projection, points: pts, remaining });
  const prevClose = basePrice(p.projection);
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
  };
}

/** Every live row, and a tick logged if the log is stale. */
async function liveBoard(now) {
  const ctx = await liveContext();
  const rows = ctx.universe.map((p) => liveRow(p, ctx));
  // A failed write must never take the board down with it.
  await recordTick(rows, now).catch(() => false);
  return { ...ctx, rows };
}

function mockRow(p, now) {
  const q = mockQuote(p.id, basePrice(p.projection), now);
  return { ...p, ...q };
}

/** Every stock with its current quote. */
export async function quotes({ source = 'live', now = Date.now() } = {}) {
  const src = normaliseSource(source);
  if (src === 'live') {
    const board = await liveBoard(now);
    return { source: src, asOf: now, season: board.season, week: board.week, rows: board.rows };
  }
  const { season, week } = await nflState();
  const universe = await loadUniverse({ season, week });
  return { source: src, asOf: now, season, week, rows: universe.map((p) => mockRow(p, now)) };
}

/** One stock: quote plus candles for a range. Null when the ticker is unknown. */
export async function history({ source = 'live', ticker, range = DEFAULT_RANGE, now = Date.now() }) {
  const src = normaliseSource(source);
  const rng = RANGES[range] ? range : DEFAULT_RANGE;
  const sym = String(ticker ?? '').toUpperCase();
  const { from, to, step } = rangeWindow(rng, now);

  if (src === 'live') {
    const board = await liveBoard(now);
    const player = board.rows.find((u) => u.ticker === sym);
    if (!player) return null;
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
