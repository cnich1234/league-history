/**
 * Prices carry between weeks.
 *
 * The price of a share is half this week's projection plus a PREMIUM: what
 * the surprises of earlier weeks have added to, or taken from, the player. At
 * the roll (the first tick after Sleeper flips the week) each player's premium
 * takes on the whole of last week's surprise and then decays a quarter, so a
 * run of big weeks builds a price up over time, a bust stays priced in until
 * he earns it back, and nothing drifts off forever. Without this, Tuesday was
 * a cliff: every price snapped back to the projection and a holder's week
 * was wiped either way.
 *
 * The roll is idempotent: one row per player per week, written once. The
 * feeds are injectable so the arithmetic can be tested against a sentinel
 * season without Sleeper.
 */
import { neon } from '@neondatabase/serverless';
import { fetchProjections, actualPoints } from '../dfs.js';
import { rollPremium, dividendFor } from './price.js';

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

const TTL = 60_000;
const cache = new Map();

/** Every player's carried premium for a week, by player id. Empty in week 1. */
export async function premiums(season, week) {
  const key = `${season}-${week}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const rows = await sql`
    select player_id, premium, dividend, prev_actual, prev_projection
    from market_baselines where season = ${season} and week = ${week}`;
  const map = new Map(
    rows.map((r) => [
      String(r.player_id),
      {
        premium: Number(r.premium),
        dividend: Number(r.dividend),
        prevActual: r.prev_actual == null ? null : Number(r.prev_actual),
        prevProjection: r.prev_projection == null ? null : Number(r.prev_projection),
      },
    ]),
  );
  cache.set(key, { at: Date.now(), map });
  return map;
}

export function forgetPremiums() {
  cache.clear();
}

/**
 * Rolls every player from one week to the next. Feeds default to Sleeper for
 * the finished week; pass them to test. Returns how many rows were written.
 */
export async function rollWeek({ season, fromWeek, toWeek, projFrom, actualFrom, premiumFrom }) {
  projFrom ??= (await fetchProjections(season, fromWeek)).projections;
  actualFrom ??= await actualPoints(season, fromWeek);
  premiumFrom ??= await premiums(season, fromWeek);

  const ids = new Set([
    ...Object.keys(projFrom).filter((id) => Number(projFrom[id]) > 0),
    ...premiumFrom.keys(),
  ]);
  const out = [];
  for (const id of ids) {
    const premium = premiumFrom.get(id)?.premium ?? 0;
    const projection = Number(projFrom[id]) || 0;
    const actual = Number(actualFrom[id]) || 0;
    const next = rollPremium({ premium, actual, projection });
    const dividend = dividendFor(actual);
    if (next === 0 && dividend === 0 && actual === 0) continue;
    out.push({ id, next, dividend, actual, projection });
  }
  if (!out.length) return { rolled: 0 };

  await sql`
    insert into market_baselines (season, week, player_id, premium, dividend, prev_actual, prev_projection)
    select ${season}, ${toWeek}, id, premium, dividend, actual, projection
    from unnest(
      ${out.map((r) => r.id)}::text[],
      ${out.map((r) => r.next)}::numeric[],
      ${out.map((r) => r.dividend)}::numeric[],
      ${out.map((r) => r.actual)}::numeric[],
      ${out.map((r) => r.projection)}::numeric[]
    ) as t(id, premium, dividend, actual, projection)
    on conflict do nothing`;
  cache.delete(`${season}-${toWeek}`);
  return { rolled: out.length, fromWeek, toWeek };
}

/** Rolls into `week` if nobody has yet. Week 1 has nothing to carry. */
export async function ensureRolled(season, week) {
  if (!(week > 1)) return { skipped: 'first week' };
  const [{ n }] = await sql`
    select count(*)::int as n from market_baselines where season = ${season} and week = ${week}`;
  if (n > 0) return { already: n };
  return rollWeek({ season, fromWeek: week - 1, toWeek: week });
}
