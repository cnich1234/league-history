import { gameLive } from './price.js';

/**
 * How often the Market's cron is allowed to touch the database.
 *
 * Vercel calls /api/market/tick every minute, and every call used to read and
 * write Neon. Neon suspends a compute after about five idle minutes, so a query
 * every minute kept it awake around the clock -- and on 2026-09-29 the free
 * plan's monthly compute ran out, Neon started answering every query with a
 * 402, and The Book and the Trophy Room went down with it.
 *
 * Most of those minutes had nothing to do. Prices only move while games are
 * on, and scratches land in the hours before kickoff. So:
 *
 *   hot    a game is on, or one kicks off within LEAD_MS -- every minute
 *   quiet  otherwise -- once an hour, on the hour
 *
 * Decided from Sleeper's scores feed, never from the database, so a quiet
 * minute costs no compute at all.
 */

/** Scratches are announced about 90 minutes before kickoff; this covers it. */
export const LEAD_MS = 3 * 60 * 60 * 1000;

/** 'hot' or 'quiet', from one week's games as the scores feed returns them. */
export function tickCadence(games, now = Date.now()) {
  const list = Array.isArray(games) ? games : Object.values(games ?? {});
  for (const g of list) {
    if (gameLive(g)) return 'hot';
    if (g?.status !== 'pre_game') continue;
    const start = Number(g.start_time) || Date.parse(g.metadata?.date_time ?? '');
    if (!Number.isFinite(start)) continue;
    // Kicking off soon -- or scheduled to have started already and not yet
    // reporting as live, which is a delayed game, not a finished one.
    if (start - now <= LEAD_MS && now - start <= LEAD_MS) return 'hot';
  }
  return 'quiet';
}

/** Whether this minute's call should do the work. */
export function shouldTick(cadence, now = Date.now()) {
  return cadence === 'hot' || new Date(now).getUTCMinutes() === 0;
}
