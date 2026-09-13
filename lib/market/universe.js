/**
 * The tradable list: who has a stock.
 *
 * Every NFL player arrives in one Sleeper call (the same projections feed
 * Daily Fantasy prices from), so listing 150 costs the same as listing 5. The
 * cut is for sanity, not performance: a market with nine hundred names is a
 * spreadsheet. Top of the projections at QB, RB, WR, TE and DEF. No kickers,
 * which the league already decided in the DFS lineup.
 *
 * Reads shared code, changes none of it.
 */
import { fetchProjections, photoFor, nameOf } from '@/lib/dfs';
import { assignTickers } from './ticker.js';

export const UNIVERSE_SIZE = 150;
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'DEF']);
const TTL = 10 * 60_000;

let cache = { key: null, at: 0, data: null };

/** Season and week from Sleeper, so this needs no database. */
export async function nflState() {
  const r = await fetch('https://api.sleeper.app/v1/state/nfl');
  if (!r.ok) throw new Error(`Sleeper state -> ${r.status}`);
  const s = await r.json();
  return { season: Number(s.season), week: Math.max(1, Number(s.week) || 1) };
}

export async function loadUniverse({ season, week }) {
  const key = `${season}-${week}`;
  if (cache.key === key && Date.now() - cache.at < TTL) return cache.data;

  const { players, projections } = await fetchProjections(season, week);
  const rows = [];
  for (const [id, p] of Object.entries(players)) {
    if (!POSITIONS.has(p.position)) continue;
    const projection = Number(projections[id]) || 0;
    if (projection <= 0) continue;
    rows.push({
      id,
      firstName: p.first_name ?? '',
      lastName: p.last_name ?? '',
      name: nameOf(p, id),
      position: p.position,
      team: p.team ?? null,
      photo: photoFor(id, p.position, p.team),
      projection,
    });
  }
  const data = assignTickers(rows).slice(0, UNIVERSE_SIZE);
  cache = { key, at: Date.now(), data };
  return data;
}

/** Drop the cache, for tests and for a manual refresh. */
export function forgetUniverse() {
  cache = { key: null, at: 0, data: null };
}
