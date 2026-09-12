import { neon } from '@neondatabase/serverless';

/**
 * Daily fantasy: salaries, and the pool a lineup is built from.
 *
 * Sleeper sells a player pool and real scoring but no PRICES -- there is no
 * salary, cost or cap field anywhere on a player record. So salaries are
 * derived from the same weekly projections the board already fetches, which has
 * a useful property: a player Sleeper rates low is cheap whether or not he
 * deserves to be, and spotting that is the whole game.
 */

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

/**
 * The price curve.
 *
 * Linear in projected points, with a floor so nobody is free, rounded to $100
 * so prices read like prices.
 *
 * Fitted so the cap genuinely binds: at these numbers a lineup of the
 * top-projected player at every slot costs about $93,700 against a $50,000 cap.
 * Roughly double, which is what forces a real choice -- you can afford chalk in
 * two or three places, not nine.
 */
export const SALARY_FLOOR = 3000;
export const SALARY_PER_POINT = 450;
export const SALARY_CAP = 50000;

/**
 * The lineup, matching the league's own Sleeper roster exactly.
 *
 * Read from the league rather than invented, so a DFS lineup is the same shape
 * people already set every week -- no new rules to learn. FLEX takes RB, WR or
 * TE, as it does there.
 */
export const LINEUP = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
export const FLEX_POSITIONS = ['RB', 'WR', 'TE'];

/**
 * Positions that get a price.
 *
 * Kickers are in because the league's lineup has a K slot and the point of this
 * is that it matches. They price into a narrow band -- about $3,100 to $6,400,
 * against $13,200 for the top quarterback -- so a kicker is closer to a fixed
 * cost than a real decision, which is roughly true of kickers generally.
 */
export const DFS_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

export function salaryFor(projection) {
  const p = Math.max(0, Number(projection) || 0);
  return Math.round((SALARY_FLOOR + p * SALARY_PER_POINT) / 100) * 100;
}

/**
 * Team defences by abbreviation.
 *
 * A DEF in Sleeper's player file has no `full_name` -- its player_id IS the
 * team abbreviation -- so priced defences rendered as "?" until this existed.
 */
const DEF_NAMES = {
  ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills',
  CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns',
  DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers',
  HOU: 'Texans', IND: 'Colts', JAX: 'Jaguars', KC: 'Chiefs',
  LAC: 'Chargers', LAR: 'Rams', LV: 'Raiders', MIA: 'Dolphins',
  MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants',
  NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SEA: 'Seahawks',
  SF: '49ers', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders',
};

export function nameOf(player, playerId) {
  if (player?.position === 'DEF') {
    const abbr = player.team || playerId;
    return DEF_NAMES[abbr] ? `${DEF_NAMES[abbr]} D/ST` : `${abbr} D/ST`;
  }
  const full = `${player?.first_name ?? ''} ${player?.last_name ?? ''}`.trim();
  return full || player?.full_name || String(playerId);
}

/**
 * Prices a week and stores it.
 *
 * Salaries refresh WEEKLY: each week is priced from its own projections, so a
 * player who breaks out gets dearer and a player who fades gets cheaper.
 *
 * Within a week they are frozen. Sleeper revises projections right through to
 * kickoff, and a lineup that was legal when it was built has to stay legal --
 * so `on conflict do nothing` means a second run for the same week changes
 * nothing. Pass `{ repriceIfUnused: true }` to rebuild a week nobody has
 * entered yet, which is refused the moment an entry exists.
 */
export async function buildSalaries(
  season,
  week,
  { players, projections, repriceIfUnused = false } = {},
) {
  if (!players) throw new Error('buildSalaries needs the player file.');
  if (!projections) throw new Error('buildSalaries needs projections.');

  const rows = [];
  for (const [playerId, raw] of Object.entries(projections)) {
    const p = players[playerId];
    if (!p || !DFS_POSITIONS.includes(p.position)) continue;
    // No projection means no price. A player Sleeper has not rated is not
    // cheap -- he is absent, which is different, and pricing him at the floor
    // would put every inactive in the league on the board at $3,000.
    const projection = Number(raw) || 0;
    if (projection <= 0) continue;

    rows.push({
      playerId,
      name: nameOf(p, playerId),
      position: p.position,
      nflTeam: p.team ?? null,
      projection: Math.round(projection * 100) / 100,
      salary: salaryFor(projection),
    });
  }

  if (repriceIfUnused) {
    const [used] = await sql`
      select count(*)::int as n from dfs_entries
      where season = ${season} and week = ${week}`.catch(() => [{ n: 0 }]);
    if (Number(used?.n ?? 0) > 0) {
      throw new Error('That week already has entries -- repricing it would move the board.');
    }
    await sql`delete from dfs_salaries where season = ${season} and week = ${week}`;
  }

  let written = 0;
  for (const r of rows) {
    const done = await sql`
      insert into dfs_salaries
        (season, week, player_id, name, position, nfl_team, projection, salary)
      values (${season}, ${week}, ${r.playerId}, ${r.name}, ${r.position},
              ${r.nflTeam}, ${r.projection}, ${r.salary})
      on conflict (season, week, player_id) do nothing
      returning player_id`;
    if (done.length) written++;
  }
  return { priced: rows.length, written };
}

/** The pool for a week, dearest first within each position. */
export async function salaryPool(season, week, position = null) {
  const rows = position
    ? await sql`
        select player_id, name, position, nfl_team, projection, salary
        from dfs_salaries
        where season = ${season} and week = ${week} and position = ${position}
        order by salary desc, name`
    : await sql`
        select player_id, name, position, nfl_team, projection, salary
        from dfs_salaries
        where season = ${season} and week = ${week}
        order by position, salary desc, name`;
  return rows.map((r) => ({
    ...r,
    projection: Number(r.projection),
    salary: Number(r.salary),
  }));
}
