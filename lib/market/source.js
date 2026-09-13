/**
 * The two places a price can come from.
 *
 *   mock   real players, invented prices that move with the clock. For
 *          watching the chart work before a single real tick is logged.
 *   live   real players, real prices from this week's projection and the
 *          Sleeper stat line, repriced while a game is on. No history yet:
 *          that arrives with the tick log in the next phase, so a live chart
 *          shows the quote and says so.
 *
 * Both return the same shapes, so the pages do not care which they got.
 */
import { fractionRemaining } from '@/lib/live';
import { actualPoints } from '@/lib/dfs';
import { loadUniverse, nflState } from './universe.js';
import { mockQuote, mockCandles } from './mock.js';
import { basePrice, livePrice } from './price.js';
import { rangeWindow, DEFAULT_RANGE, RANGES } from './candles.js';

export const SOURCES = ['mock', 'live'];
export const normaliseSource = (s) => (s === 'live' ? 'live' : 'mock');

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

function mockRow(p, now) {
  const q = mockQuote(p.id, basePrice(p.projection), now);
  return { ...p, ...q };
}

async function liveContext() {
  const { season, week } = await nflState();
  const [universe, points, games] = await Promise.all([
    loadUniverse({ season, week }),
    actualPoints(season, week).catch(() => ({})),
    gamesByTeam(season, week).catch(() => ({})),
  ]);
  return { season, week, universe, points, games };
}

function liveRow(p, { points, games }) {
  const game = p.team ? games[p.team] : null;
  const remaining = game ? fractionRemaining(game) : 1;
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
    inGame: Boolean(game) && remaining > 0 && remaining < 1,
    points: pts,
    remaining,
  };
}

/** Every stock with its current quote. */
export async function quotes({ source = 'mock', now = Date.now() } = {}) {
  const src = normaliseSource(source);
  if (src === 'live') {
    const ctx = await liveContext();
    return {
      source: src,
      asOf: now,
      season: ctx.season,
      week: ctx.week,
      rows: ctx.universe.map((p) => liveRow(p, ctx)),
    };
  }
  const { season, week } = await nflState();
  const universe = await loadUniverse({ season, week });
  return { source: src, asOf: now, season, week, rows: universe.map((p) => mockRow(p, now)) };
}

/** One stock: quote plus candles for a range. Null when the ticker is unknown. */
export async function history({ source = 'mock', ticker, range = DEFAULT_RANGE, now = Date.now() }) {
  const src = normaliseSource(source);
  const rng = RANGES[range] ? range : DEFAULT_RANGE;
  const sym = String(ticker ?? '').toUpperCase();

  if (src === 'live') {
    const ctx = await liveContext();
    const p = ctx.universe.find((u) => u.ticker === sym);
    if (!p) return null;
    return {
      source: src,
      asOf: now,
      range: rng,
      player: liveRow(p, ctx),
      candles: [],
      note: 'Live prices are real. History starts when the tick log is switched on.',
    };
  }

  const { season, week } = await nflState();
  const universe = await loadUniverse({ season, week });
  const p = universe.find((u) => u.ticker === sym);
  if (!p) return null;
  const { from, to, step } = rangeWindow(rng, now);
  return {
    source: src,
    asOf: now,
    range: rng,
    player: mockRow(p, now),
    candles: mockCandles(p.id, basePrice(p.projection), from, to, step),
  };
}
