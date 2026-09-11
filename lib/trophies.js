import { neon } from '@neondatabase/serverless';
import { ACHIEVEMENTS, byId } from '../scripts/achievements.mjs';

/**
 * Weekly trophy scoring, in the database.
 *
 * This used to live in data/weekly.json, written by a script and read at build
 * time. That had a failure mode worth naming: the Tuesday cron could score a
 * week perfectly and nothing would appear, because the site only picks up a
 * file change on a rebuild -- and the cron does not trigger one. Trophies would
 * have been silently invisible all season.
 *
 * Rows instead. The page reads them at request time like every other live
 * number in the app, and the points grant reads the same rows rather than a
 * separate copy of the same arithmetic.
 */

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

export { ACHIEVEMENTS, byId };

/**
 * Stores one scored week, replacing any previous scoring of it.
 *
 * Idempotent on purpose: a correction is just running the scorer again. The
 * awards are deleted and rewritten rather than merged, so an award that no
 * longer applies after a fix genuinely disappears.
 */
export async function saveWeek(season, built) {
  const { week, awards, median, weekWinnerPoints } = built;

  await sql`
    insert into weekly_scores (season, week, median, week_winner_points, payload, scored_at)
    values (${season}, ${week}, ${median}, ${weekWinnerPoints}, ${JSON.stringify(built)}::jsonb, now())
    on conflict (season, week) do update
      set median = excluded.median,
          week_winner_points = excluded.week_winner_points,
          payload = excluded.payload,
          scored_at = now()`;

  await sql`delete from weekly_awards where season = ${season} and week = ${week}`;
  for (const a of awards) {
    await sql`
      insert into weekly_awards (season, week, bettor, achievement, points, detail)
      values (${season}, ${week}, ${a.slug}, ${a.achievement}, ${a.points}, ${a.detail ?? null})
      on conflict do nothing`;
  }

  return { week, awards: awards.length };
}

/** Every scored week, oldest first. */
export async function getWeeks(season) {
  const rows = await sql`
    select week, payload from weekly_scores where season = ${season} order by week`;
  return rows.map((r) => r.payload);
}

/** One scored week, or null. */
export async function getWeek(season, week) {
  const [row] = await sql`
    select payload from weekly_scores where season = ${season} and week = ${week}`;
  return row?.payload ?? null;
}

/**
 * Season standings, recomputed from the award rows.
 *
 * Derived rather than stored incrementally: re-scoring a corrected week cannot
 * leave a stale total behind, because there is no total to go stale.
 */
export async function getSeasonStandings(season) {
  const rows = await sql`
    select a.bettor as slug,
           b.display_name,
           sum(a.points)::int as points,
           count(*)::int as awards
    from weekly_awards a
    join bettors b on b.slug = a.bettor
    where a.season = ${season}
    group by a.bettor, b.display_name
    order by points desc, b.display_name`;

  const badges = await sql`
    select bettor, achievement, count(*)::int as n
    from weekly_awards where season = ${season}
    group by bettor, achievement`;

  const byBettor = {};
  for (const r of badges) (byBettor[r.bettor] ??= {})[r.achievement] = r.n;

  // Weeks won: most points in a week, ties included.
  const weekTotals = await sql`
    select week, bettor, sum(points)::int as pts
    from weekly_awards where season = ${season}
    group by week, bettor`;
  const bestPerWeek = {};
  for (const r of weekTotals) {
    bestPerWeek[r.week] = Math.max(bestPerWeek[r.week] ?? -Infinity, r.pts);
  }
  const weeksWon = {};
  for (const r of weekTotals) {
    if (r.pts === bestPerWeek[r.week]) weeksWon[r.bettor] = (weeksWon[r.bettor] ?? 0) + 1;
  }

  return rows.map((r) => ({
    slug: r.slug,
    name: r.display_name,
    points: r.points,
    awards: r.awards,
    weeksWon: weeksWon[r.slug] ?? 0,
    badges: byBettor[r.slug] ?? {},
  }));
}

/** Trophy points earned in one week, as { slug: points }, for the shop grant. */
export async function weekPointsBySlug(season, week) {
  const rows = await sql`
    select bettor, sum(points)::int as points
    from weekly_awards where season = ${season} and week = ${week}
    group by bettor`;
  return Object.fromEntries(rows.map((r) => [r.bettor, r.points]));
}
