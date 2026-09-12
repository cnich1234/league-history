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

/* ---------- lineups ---------- */

/**
 * The points a finishing position pays in the weekly.
 *
 * New money, and the largest single source of points in the app: 79 a week
 * across ten managers, 1,106 a season. That was a deliberate choice -- the shop
 * was priced against a 197-point season and this loosens it by roughly a third.
 */
export const PLACE_POINTS = [20, 17, 13, 10, 8, 5, 3, 2, 1, 0];

export function placePoints(place) {
  const i = Number(place) - 1;
  if (!Number.isInteger(i) || i < 0) return 0;
  return PLACE_POINTS[i] ?? 0;
}

/**
 * Checks a lineup against the shape and the cap.
 *
 * Returns { ok, why, salaryUsed }. Every rule is re-checked server-side on
 * entry: the builder enforces the same ones, but a component is a suggestion.
 */
export function validateLineup(slots, pool) {
  const byId = new Map(pool.map((p) => [String(p.player_id), p]));

  if (!Array.isArray(slots) || slots.length !== LINEUP.length) {
    return { ok: false, why: `A lineup is ${LINEUP.length} players.` };
  }

  const seen = new Set();
  let salaryUsed = 0;

  for (const [i, slot] of LINEUP.entries()) {
    const id = slots[i] == null ? null : String(slots[i]);
    if (!id) return { ok: false, why: `Fill the ${slot} slot.` };

    const p = byId.get(id);
    if (!p) return { ok: false, why: 'That player is not in this week\'s pool.' };

    // The same player twice would be a free way to double up on a good week.
    if (seen.has(id)) return { ok: false, why: `${p.name} is in there twice.` };
    seen.add(id);

    const allowed = slot === 'FLEX' ? FLEX_POSITIONS : [slot];
    if (!allowed.includes(p.position)) {
      return { ok: false, why: `${p.name} is a ${p.position}, not a ${slot}.` };
    }

    salaryUsed += Number(p.salary);
  }

  if (salaryUsed > SALARY_CAP) {
    return {
      ok: false,
      why: `That is $${(salaryUsed - SALARY_CAP).toLocaleString()} over the cap.`,
      salaryUsed,
    };
  }

  return { ok: true, salaryUsed };
}

/** The weekly contest for a week, created on demand. */
export async function weeklyContest(season, week, locksAt = null) {
  const [existing] = await sql`
    select * from dfs_contests
    where season = ${season} and week = ${week} and kind = 'weekly'`;
  if (existing) return existing;

  const [made] = await sql`
    insert into dfs_contests (season, week, kind, name, locks_at)
    values (${season}, ${week}, 'weekly', ${'Week ' + week}, ${locksAt})
    on conflict do nothing
    returning *`;
  if (made) return made;

  // Lost a race with another request; the row exists now.
  const [row] = await sql`
    select * from dfs_contests
    where season = ${season} and week = ${week} and kind = 'weekly'`;
  return row;
}

/**
 * Saves a lineup.
 *
 * One per manager per contest: entering again EDITS rather than adding, which
 * is also what stops somebody buying two seats in a lobby to double their
 * chance at the pot.
 *
 * A lobby buy-in is escrowed on the first entry only -- editing is free, or
 * changing your mind after kickoff would cost points every time.
 */
export async function enterContest({ slug, contestId, slots, season, week }) {
  const [contest] = await sql`select * from dfs_contests where id = ${contestId}`;
  if (!contest) throw new Error('No such contest.');
  if (contest.status !== 'open') throw new Error('That contest has closed.');
  if (contest.locks_at && new Date(contest.locks_at) <= new Date()) {
    throw new Error('That contest has locked.');
  }

  const pool = await salaryPool(season ?? contest.season, week ?? contest.week);
  const check = validateLineup(slots, pool);
  if (!check.ok) throw new Error(check.why);

  const [already] = await sql`
    select id from dfs_entries where contest_id = ${contestId} and bettor = ${slug}`;

  // A lobby has a fixed number of seats, and a new entrant takes one.
  if (!already && contest.kind === 'lobby') {
    const [{ taken }] = await sql`
      select count(*)::int as taken from dfs_entries where contest_id = ${contestId}`;
    if (Number(taken) >= Number(contest.seats)) throw new Error('That lobby is full.');

    const buyin = Number(contest.buyin_points);
    if (buyin > 0) {
      const { getPoints } = await import('./shop.js');
      const held = await getPoints(slug, contest.season);
      if (held < buyin) throw new Error(`That costs ${buyin} points, you have ${held}.`);
      await sql`
        insert into point_ledger (bettor, season, amount, reason, note)
        values (${slug}, ${contest.season}, ${-buyin}, 'purchase',
                ${'Lobby buy-in: ' + (contest.name ?? 'contest')})`;
    }
  }

  const [row] = await sql`
    insert into dfs_entries (contest_id, season, week, bettor, slots, salary_used)
    values (${contestId}, ${contest.season}, ${contest.week}, ${slug},
            ${JSON.stringify(slots)}::jsonb, ${check.salaryUsed})
    on conflict (contest_id, bettor)
    do update set slots = ${JSON.stringify(slots)}::jsonb,
                  salary_used = ${check.salaryUsed},
                  updated_at = now()
    returning id, salary_used`;

  return { id: String(row.id), salaryUsed: Number(row.salary_used), edited: Boolean(already) };
}

/** Somebody's entry in a contest, if any. */
export async function myEntry(slug, contestId) {
  const [row] = await sql`
    select id, slots, salary_used, points, place
    from dfs_entries where contest_id = ${contestId} and bettor = ${slug}`;
  return row ? { ...row, salary_used: Number(row.salary_used) } : null;
}

/* ---------- lobbies ---------- */

/**
 * Opens a lobby.
 *
 * Points here are RECYCLED, not minted: buy-ins are escrowed, pooled, and the
 * winner takes the lot. Net zero by construction, which is why lobbies can be
 * tuned freely -- no buy-in is large enough to inflate anything.
 *
 * The host is charged on creation, the same way posting a bounty charges the
 * poster: an empty lobby with a big advertised pot would be a lie, and you
 * should not be able to open one you cannot sit in.
 */
export async function openLobby({ slug, season, week, name, seats, buyinPoints, locksAt = null }) {
  const nSeats = Math.round(Number(seats));
  const buyin = Math.round(Number(buyinPoints));

  if (!Number.isInteger(nSeats) || nSeats < 2 || nSeats > 10) {
    throw new Error('A lobby seats between 2 and 10.');
  }
  if (!Number.isInteger(buyin) || buyin < 1) throw new Error('Set a buy-in of at least 1 point.');

  const { getPoints } = await import('./shop.js');
  const held = await getPoints(slug, season);
  if (held < buyin) throw new Error(`That costs ${buyin} points to sit in, you have ${held}.`);

  const [row] = await sql`
    insert into dfs_contests (season, week, kind, name, host, seats, buyin_points, locks_at)
    values (${season}, ${week}, 'lobby', ${name?.trim() || null}, ${slug},
            ${nSeats}, ${buyin}, ${locksAt})
    returning *`;

  return row;
}

/**
 * Open lobbies for a week, with how full each is.
 *
 * `seats_taken` is counted rather than stored, for the same reason balances are
 * derived everywhere else: a stored count drifts and nothing notices.
 */
export async function openLobbies(season, week) {
  const rows = await sql`
    select c.*, h.display_name as host_name,
           count(e.id)::int as seats_taken
    from dfs_contests c
    join bettors h on h.slug = c.host
    left join dfs_entries e on e.contest_id = c.id
    where c.season = ${season} and c.week = ${week}
      and c.kind = 'lobby' and c.status = 'open'
    group by c.id, h.display_name
    order by c.buyin_points desc, c.created_at`;
  return rows.map((r) => ({
    ...r,
    id: String(r.id),
    seats: Number(r.seats),
    seats_taken: Number(r.seats_taken),
    buyin_points: Number(r.buyin_points),
    pot: Number(r.buyin_points) * Number(r.seats_taken),
  }));
}

/** Who is sitting in a contest. */
export async function contestField(contestId) {
  const rows = await sql`
    select e.bettor, e.salary_used, e.points, e.place, t.display_name
    from dfs_entries e
    join bettors t on t.slug = e.bettor
    where e.contest_id = ${contestId}
    order by e.points desc nulls last, e.created_at`;
  return rows.map((r) => ({
    ...r,
    salary_used: Number(r.salary_used),
    points: r.points == null ? null : Number(r.points),
  }));
}

/**
 * Refunds a lobby that never filled and closes it.
 *
 * A contest with empty seats cannot be settled fairly -- the pot is short and
 * the field is not what anybody bought into -- so everybody gets their buy-in
 * back. Called from the cron at lock time.
 */
export async function voidLobby(contestId, why) {
  const [c] = await sql`select * from dfs_contests where id = ${contestId}`;
  if (!c || c.status !== 'open') return 0;

  const entries = await sql`select bettor from dfs_entries where contest_id = ${contestId}`;
  const buyin = Number(c.buyin_points);
  if (buyin > 0) {
    for (const e of entries) {
      await sql`
        insert into point_ledger (bettor, season, amount, reason, note)
        values (${e.bettor}, ${c.season}, ${buyin}, 'refund',
                ${'Lobby refunded -- ' + why})`;
    }
  }
  await sql`update dfs_contests set status = 'void', settled_at = now() where id = ${contestId}`;
  return entries.length;
}

/* ---------- scoring and settlement ---------- */

/**
 * What every player actually scored, from Sleeper.
 *
 * The same half-PPR number the league scores on, so a DFS lineup and a real
 * lineup are measured identically. Deliberately not the roster-based map
 * lib/cron.js builds: that only covers players somebody in the league rosters,
 * and a DFS pool is every NFL player.
 */
export async function actualPoints(season, week) {
  const res = await fetch(
    `https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular`,
  );
  if (!res.ok) throw new Error(`Sleeper stats ${season}/${week} -> ${res.status}`);
  const rows = await res.json();
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.player_id) continue;
    out[String(r.player_id)] = Number(r.stats?.pts_half_ppr ?? r.stats?.pts_ppr ?? 0);
  }
  return out;
}

/** A lineup's score. A player who did not play counts zero, not nothing. */
export function scoreLineup(slots, points) {
  return (
    Math.round(
      (slots ?? []).reduce((n, id) => n + (id ? Number(points[String(id)] ?? 0) : 0), 0) * 100,
    ) / 100
  );
}

/**
 * Scores and settles a contest.
 *
 * Where the two kinds diverge, and the only place it matters:
 *
 *   weekly  finishing position MINTS points off PLACE_POINTS.
 *   lobby   the pot is RECYCLED -- winner takes the buy-ins already escrowed,
 *           so nothing new enters the economy.
 *
 * Ties share. A weekly tie splits the sum of the places involved, so two
 * managers tied for first take (20 + 17) / 2 rather than 20 each -- otherwise a
 * tie would mint more than the curve promises. A lobby tie splits the pot, with
 * the remainder to whoever entered first.
 */
export async function settleContest(contestId, { points = null } = {}) {
  const [c] = await sql`select * from dfs_contests where id = ${contestId}`;
  if (!c) throw new Error('No such contest.');
  if (c.status === 'settled' || c.status === 'void') {
    return { settled: 0, note: 'already settled' };
  }

  const scores = points ?? (await actualPoints(c.season, c.week));
  const entries = await sql`
    select id, bettor, slots from dfs_entries where contest_id = ${contestId} order by created_at`;
  if (!entries.length) {
    await sql`update dfs_contests set status = 'void', settled_at = now() where id = ${contestId}`;
    return { settled: 0, note: 'nobody entered' };
  }

  const scored = entries
    .map((e) => ({ ...e, score: scoreLineup(e.slots, scores) }))
    .sort((a, b) => b.score - a.score);

  // Standard competition ranking: ties share a place and the next one skips.
  let place = 0;
  let seen = 0;
  let lastScore = null;
  for (const row of scored) {
    seen++;
    if (lastScore == null || row.score !== lastScore) {
      place = seen;
      lastScore = row.score;
    }
    row.place = place;
    await sql`
      update dfs_entries set points = ${row.score}, place = ${row.place}
      where id = ${row.id}`;
  }

  const paid = [];
  if (c.kind === 'weekly') {
    // Minted. A tie splits the places it spans, so the curve pays out exactly
    // what it promises however the field finishes.
    const byPlace = {};
    for (const r of scored) (byPlace[r.place] ??= []).push(r);
    for (const [p, group] of Object.entries(byPlace)) {
      const start = Number(p);
      const span = group.length;
      const pot = Array.from({ length: span }, (_, i) => placePoints(start + i)).reduce(
        (a, b) => a + b,
        0,
      );
      const each = Math.floor(pot / span);
      for (const r of group) {
        if (each <= 0) continue;
        await sql`
          insert into point_ledger (bettor, season, week, amount, reason, note)
          values (${r.bettor}, ${c.season}, ${c.week}, ${each}, 'trophies',
                  ${'Daily fantasy: ' + ordinal(start)})
          on conflict do nothing`;
        paid.push({ bettor: r.bettor, place: start, points: each });
      }
    }
  } else {
    // Recycled. The pot is what was escrowed on entry, and it all goes out.
    const pot = Number(c.buyin_points) * entries.length;
    const winners = scored.filter((r) => r.place === 1);
    const each = Math.floor(pot / winners.length);
    let remainder = pot - each * winners.length;
    for (const r of winners) {
      // Earliest entrant takes the odd point, so the parts add back to the pot.
      const amount = each + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      if (amount <= 0) continue;
      await sql`
        insert into point_ledger (bettor, season, week, amount, reason, note)
        values (${r.bettor}, ${c.season}, ${c.week}, ${amount}, 'refund',
                ${'Lobby won: ' + (c.name ?? 'contest')})`;
      paid.push({ bettor: r.bettor, place: 1, points: amount });
    }
  }

  await sql`
    update dfs_contests set status = 'settled', settled_at = now() where id = ${contestId}`;
  return { settled: scored.length, paid };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
