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
 * Calibrated against DraftKings, because "the prices are too high" turned out
 * not to be about the floor at all.
 *
 * The RATIO was always fine -- cheapest useful player to dearest was 3.9x
 * against DK's 3.3x. The problem was the absolute scale relative to the cap. At
 * $500 a point the dearest player was $13,800, so a $50,000 cap bought 3.6 of
 * him; DK's cap buys 5.0 of its priciest. That difference is the whole
 * complaint: a lineup of merely DECENT players -- the 21st best at every slot --
 * came to $62,400 and did not fit. You could not build a good team, only one
 * star and eight bodies at the floor.
 *
 * At $320 a point the dearest is $9,500, the cap buys 5.3 of him, and a lineup
 * of roughly the 11th best everywhere just fits at $52,300. The all-chalk
 * lineup is $65,800 -- still over, so the cap still binds, but 1.3x rather than
 * an unreachable 1.9x.
 *
 * The floor stays $2,000. It is worth knowing it does NOT buy a usable player:
 * about 27 of the pool project at or near zero and sit at the floor, so a
 * minimum-price slot is a wasted one rather than a bargain.
 */
export const SALARY_FLOOR = 2000;
export const SALARY_PER_POINT = 320;
export const SALARY_CAP = 50000;

/**
 * The lineup: nine slots, as traditional DFS uses.
 *
 * Started as the league's own Sleeper roster, which carries three WRs. That is
 * ten slots once the kicker is counted, and ten of eleven positions filled
 * before any choice is made -- so it dropped to two WRs to match what daily
 * fantasy actually looks like. FLEX still takes RB, WR or TE, so a third
 * receiver is a decision rather than a requirement.
 */
export const LINEUP = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
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

/**
 * The lowest projection worth putting on the board.
 *
 * Not a price floor -- a PLAYABILITY floor. Anybody under this is not a cheap
 * option, he is a player who will not score, and listing him only buries the
 * real value picks beneath rows nobody would ever take.
 */
export const PLAYABLE_FLOOR = 4;

/**
 * Projections for a week, with the player metadata attached.
 *
 * One request. Each row carries a `player` block -- first_name, last_name,
 * position, team -- so the caller gets a player index for free rather than
 * needing the full file.
 */
/**
 * The league's own scoring rules, fetched once and cached for the process.
 *
 * Sleeper's projection rows carry pts_half_ppr, pts_ppr and pts_std -- none of
 * which is what this league plays. Passing touchdowns are worth 6 here rather
 * than 4, interceptions -2, receptions a full point, and there are yardage
 * bonuses on top. So the packaged numbers are somebody else's game.
 */
let _scoring = null;
export async function leagueScoring() {
  if (_scoring) return _scoring;
  const id = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
  const res = await fetch(`https://api.sleeper.app/v1/league/${id}`);
  if (!res.ok) throw new Error(`Sleeper league ${id} -> ${res.status}`);
  const league = await res.json();
  _scoring = league?.scoring_settings ?? null;
  if (!_scoring) throw new Error('That league has no scoring settings.');
  return _scoring;
}

/**
 * A stat line scored under this league's rules.
 *
 * Every weighted stat, not a fixed list: the league charges for sacks and pays
 * bonuses at 100/200 rushing and 300/400 passing yards, and a hand-written
 * formula would quietly miss them the first time somebody changed a setting.
 *
 * The pts_* keys are Sleeper's own pre-scored totals and must be skipped, or
 * they would be counted a second time on top of the stats that produced them.
 */
export function scoreStats(stats, scoring) {
  let total = 0;
  for (const [stat, value] of Object.entries(stats ?? {})) {
    if (stat.startsWith('pts_') || stat.startsWith('adp') || stat.startsWith('pos_')) continue;
    if (stat === 'gp') continue;
    const weight = scoring?.[stat];
    if (typeof weight !== 'number' || !weight) continue;
    total += Number(value) * weight;
  }
  return Math.round(total * 100) / 100;
}

export async function fetchProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sleeper projections ${season}/${week} -> ${res.status}`);
  const rows = await res.json();

  // Scored under THIS league's rules rather than taking Sleeper's packaged
  // pts_half_ppr, which is a different game: it had Hurts at 22.15 where the
  // league's own rules give 25.02, because passing touchdowns are worth six
  // here. Salaries are derived from projections, so using the wrong scoring
  // underprices every quarterback.
  const scoring = await leagueScoring().catch(() => null);

  const players = {};
  const projections = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.player_id;
    if (!id) continue;
    const p = r.player ?? {};
    players[String(id)] = {
      first_name: p.first_name,
      last_name: p.last_name,
      position: p.position,
      team: p.team ?? p.team_abbr ?? null,
    };
    projections[String(id)] = scoring
      ? scoreStats(r.stats, scoring)
      : Number(r.stats?.pts_half_ppr ?? r.stats?.pts_ppr ?? 0);
  }
  return { players, projections };
}

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

/**
 * Where a player's picture lives.
 *
 * Sleeper hosts headshots on its CDN with no key and no rate limit, keyed by
 * player id. Defences have no headshot, so they get the team logo instead --
 * which is what people picture anyway when they think "Jaguars D".
 *
 * A player with no photo returns 403 rather than a placeholder, so whatever
 * renders this needs a fallback.
 */
export function photoFor(playerId, position, nflTeam) {
  if (position === 'DEF') {
    const abbr = (nflTeam || playerId || '').toLowerCase();
    return abbr ? `https://sleepercdn.com/images/team_logos/nfl/${abbr}.png` : null;
  }
  return playerId ? `https://sleepercdn.com/content/nfl/players/${playerId}.jpg` : null;
}

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
  // Fetch our own if none were handed in. Sleeper's projections carry a
  // `player` block with name, position and team, which is everything a salary
  // needs -- so this does NOT need the 15MB player file, which cannot ship in
  // a serverless bundle and whose slim stand-in holds only rostered players
  // with no team at all.
  if (!projections) {
    const fetched = await fetchProjections(season, week);
    players = players ?? fetched.players;
    projections = fetched.projections;
  }
  if (!players) throw new Error('buildSalaries needs the player file.');

  const rows = [];
  for (const [playerId, raw] of Object.entries(projections)) {
    const p = players[playerId];
    if (!p || !DFS_POSITIONS.includes(p.position)) continue;
    // Below the cut is not cheap, it is unplayable.
    //
    // Pricing everything Sleeper rated above zero put 98 players -- 22% of the
    // board -- under two projected points, and because they were the cheapest
    // rows they were the FIRST thing anybody saw when looking for a bargain.
    // Four zero-point receivers at $2,000 are not four options; they are noise
    // at the top of the list.
    //
    // DraftKings curates a main slate to roughly 45 RBs and 65 WRs. A cut at
    // PLAYABLE_FLOOR gives 60 and 94, which is the same shape.
    const projection = Number(raw) || 0;
    if (projection < PLAYABLE_FLOOR) continue;

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

/**
 * The pool for a week, dearest first within each position.
 *
 * Each player carries the defence they are facing and how it ranks, so the
 * card can say "vs LAR, #1 D" -- which is what decides between two players at
 * the same price. A defence is scored against the offence IT faces, so for a
 * DEF the matchup is inverted back again.
 */
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
  const matchups = await defenseMatchups(season, week);
  return rows.map((r) => {
    const m = r.nfl_team ? matchups[String(r.nfl_team).toUpperCase()] : null;
    return {
      ...r,
      projection: Number(r.projection),
      salary: Number(r.salary),
      // Who they play, and how good that defence is. Null when the week has no
      // rankings yet -- the card just omits the line rather than guessing.
      opponent: m?.opponent ?? null,
      defRank: m?.rank ?? null,
      defOf: m?.of ?? null,
      // True when the ranking is carried over from an earlier week because
      // this one is not published yet. The fixture is still this week's.
      defStale: m?.stale ?? false,
      defRankedWeek: m?.rankedWeek ?? null,
    };
  });
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

  // Per-player locking. A lineup is editable while every player in it is yet to
  // play; one started player freezes it, because a swap after that is made
  // knowing something. Checked against the SAVED lineup as well as the new one,
  // or somebody could edit away from a player who had already kicked off.
  const locked = await lockedPlayers(contest.season, contest.week);
  if (locked.size) {
    const [saved] = await sql`
      select slots from dfs_entries where contest_id = ${contestId} and bettor = ${slug}`;
    const frozen = lineupLocked(saved?.slots, locked) || lineupLocked(slots, locked);
    if (frozen) {
      throw new Error('Somebody in that lineup has already played -- it is locked.');
    }
  }

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

  // The draft has served its purpose; leaving it would mean a later refresh
  // could show a half-built lineup over a submitted one.
  await clearDraft(slug, contestId);

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
export async function contestField(contestId, { withLineups = false } = {}) {
  const rows = await sql`
    select e.bettor, e.slots, e.salary_used, e.points, e.place, t.display_name
    from dfs_entries e
    join bettors t on t.slug = e.bettor
    where e.contest_id = ${contestId}
    order by e.points desc nulls last, e.created_at`;
  return rows.map((r) => ({
    bettor: r.bettor,
    display_name: r.display_name,
    salary_used: Number(r.salary_used),
    points: r.points == null ? null : Number(r.points),
    place: r.place,
    // Lineups are withheld unless asked for, and the caller only asks once a
    // contest has locked. Before that, showing them turns a contest into a
    // copying exercise.
    slots: withLineups ? r.slots : null,
  }));
}

/**
 * A week's contests with everybody's lineup, scored live.
 *
 * The results view: who is in, what they picked, and what it is worth right
 * now. Lineups are only included for contests that have LOCKED -- an open one
 * is still being edited, and publishing it would let the last person in copy
 * the best lineup on the board.
 */
export async function weekResults(season, week, { live = true } = {}) {
  const contests = await sql`
    select c.id, c.kind, c.name, c.status, c.buyin_points, c.seats,
           h.display_name as host_name
    from dfs_contests c
    left join bettors h on h.slug = c.host
    where c.season = ${season} and c.week = ${week}
      and c.status in ('locked', 'settled')
    order by c.kind, c.created_at`;
  if (!contests.length) return { contests: [], pool: {} };

  // One fetch of live scores, shared across every contest -- ten lobbies
  // asking Sleeper separately is ten chances to get a different answer.
  const scores = live ? await actualPoints(season, week).catch(() => ({})) : {};
  const pool = Object.fromEntries(
    (await salaryPool(season, week)).map((p) => [String(p.player_id), p]),
  );

  const out = [];
  for (const c of contests) {
    const field = await contestField(Number(c.id), { withLineups: true });
    const scored = field
      .map((f) => ({
        ...f,
        // A settled contest keeps the number it settled at; a locked one is
        // scored live, so the page moves while the games run.
        live: f.points != null ? f.points : scoreLineup(f.slots, scores),
        players: (f.slots ?? []).map((id, i) => {
          const p = pool[String(id)] ?? null;
          return {
            slot: LINEUP[i],
            id: String(id),
            name: p?.name ?? String(id),
            position: p?.position ?? '?',
            nflTeam: p?.nfl_team ?? null,
            salary: p ? Number(p.salary) : 0,
            points: Number(scores[String(id)] ?? 0),
          };
        }),
      }))
      .sort((a, b) => b.live - a.live);

    out.push({
      ...c,
      id: String(c.id),
      buyin_points: Number(c.buyin_points),
      pot: Number(c.buyin_points) * field.length,
      field: scored,
    });
  }
  return { contests: out, pool };
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

  // Scored under the league's rules, exactly as projections are. Settling on
  // Sleeper's packaged pts_half_ppr would pay out on a different game from the
  // one the salaries were priced for -- and would disagree with the number
  // everybody can see in the Sleeper app.
  const scoring = await leagueScoring().catch(() => null);

  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.player_id) continue;
    out[String(r.player_id)] = scoring
      ? scoreStats(r.stats, scoring)
      : Number(r.stats?.pts_half_ppr ?? r.stats?.pts_ppr ?? 0);
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

/* ---------- locking ---------- */

/**
 * Which players in a week have already kicked off.
 *
 * DFS locks per PLAYER, not per contest. Somebody rostering only late games
 * should keep editing while the early ones run -- the same rule a prop follows
 * on the board, where a Thursday player closes Thursday and a Sunday player
 * does not.
 */
export async function lockedPlayers(season, week) {
  const { kickedOffTeams } = await import('./live.js');
  const started = await kickedOffTeams(season, week);
  if (!started || started.size === 0) return new Set();

  const rows = await sql`
    select player_id from dfs_salaries
    where season = ${season} and week = ${week}
      and nfl_team = any(${[...started]})`;
  return new Set(rows.map((r) => String(r.player_id)));
}

/**
 * Is this lineup still editable?
 *
 * Editable while every player in it is yet to play. One started player freezes
 * the whole lineup, because a swap after that is a swap made knowing something
 * -- and a lineup is a single bet, not ten.
 */
export function lineupLocked(slots, locked) {
  return (slots ?? []).some((id) => id && locked.has(String(id)));
}

/**
 * Locks contests whose field can no longer be edited, and voids lobbies that
 * never filled.
 *
 * Runs from the cron. A lobby with empty seats cannot settle fairly -- the pot
 * is short and the field is not what anybody bought into -- so it refunds
 * rather than paying a winner who beat two people in a five-seat game.
 */
export async function lockDueContests(season, week) {
  const { kickedOffTeams } = await import('./live.js');
  const started = await kickedOffTeams(season, week);
  if (!started || started.size === 0) return { locked: 0, voided: 0 };

  const open = await sql`
    select id, kind, seats, locks_at from dfs_contests
    where season = ${season} and week = ${week} and status = 'open'`;

  let locked = 0;
  let voided = 0;
  for (const c of open) {
    // A lobby that never filled is refunded rather than locked: it cannot be
    // settled against the field people paid to join.
    if (c.kind === 'lobby' && c.seats != null) {
      const [{ taken }] = await sql`
        select count(*)::int as taken from dfs_entries where contest_id = ${c.id}`;
      if (Number(taken) < Number(c.seats)) {
        await voidLobby(Number(c.id), 'it never filled');
        voided++;
        continue;
      }
    }
    await sql`update dfs_contests set status = 'locked' where id = ${c.id}`;
    locked++;
  }
  return { locked, voided };
}

/**
 * Settles every locked contest for a week.
 *
 * Scores are fetched once and shared, rather than per contest: a week has one
 * set of results and ten lobbies asking Sleeper for them separately is ten
 * chances to get a different answer.
 */
export async function settleWeek(season, week) {
  const due = await sql`
    select id from dfs_contests
    where season = ${season} and week = ${week} and status = 'locked'`;
  if (!due.length) return { contests: 0 };

  const points = await actualPoints(season, week);
  const results = [];
  for (const c of due) {
    results.push(await settleContest(Number(c.id), { points }));
  }
  return { contests: due.length, results };
}

/* ---------- defence rankings ---------- */

/**
 * How good is the defence each team is facing this week?
 *
 * A salary says what a player costs and a projection says what he is expected
 * to do. Neither says whether he is up against the best defence in the league
 * or the worst, which is the thing that decides between two players at the same
 * price.
 *
 * FantasyPros ranks all 32 defences for a week and names the opponent each one
 * faces, so one request gives both the ranking and the fixture.
 */
export async function fetchDefenseRanks(season, week) {
  const key = process.env.FANTASYPROS_API_KEY;
  if (!key) throw new Error('FANTASYPROS_API_KEY is not set.');

  const url =
    `https://api.fantasypros.com/public/v2/json/nfl/${season}/consensus-rankings` +
    `?position=DST&week=${week}`;
  const res = await fetch(url, { headers: { 'x-api-key': key } });
  if (!res.ok) throw new Error(`FantasyPros ${season}/${week} -> ${res.status}`);
  const body = await res.json();

  // A free-tier key authenticates but returns an empty player list with
  // `public_api_limited` set. Saying so beats writing an empty table and
  // wondering later why every card has no ranking.
  const rows = Array.isArray(body?.players) ? body.players : [];
  if (!rows.length) {
    throw new Error(
      body?.public_api_limited
        ? `FantasyPros returned nothing for ${season} week ${week} (tier: ${body.tier ?? '?'}).`
        : `FantasyPros returned no defences for ${season} week ${week}.`,
    );
  }

  return rows
    .map((p) => ({
      team: String(p.player_team_id ?? '').toUpperCase(),
      rankAve: p.rank_ave == null ? null : Number(p.rank_ave),
      rankEcr: p.rank_ecr == null ? null : Math.round(Number(p.rank_ecr)),
      opponent: p.player_opponent_id ? String(p.player_opponent_id).toUpperCase() : null,
    }))
    .filter((r) => r.team);
}

/** Stores a week's defence rankings. Refreshed rather than frozen: a ranking is
 *  a live opinion, and unlike a salary nobody has drafted against it. */
export async function buildDefenseRanks(season, week, { ranks = null } = {}) {
  const rows = ranks ?? (await fetchDefenseRanks(season, week));
  let written = 0;
  for (const r of rows) {
    await sql`
      insert into defense_ranks (season, week, team, rank_ave, rank_ecr, opponent)
      values (${season}, ${week}, ${r.team}, ${r.rankAve}, ${r.rankEcr}, ${r.opponent})
      on conflict (season, week, team)
      do update set rank_ave = ${r.rankAve}, rank_ecr = ${r.rankEcr},
                    opponent = ${r.opponent}, fetched_at = now()`;
    written++;
  }
  return { written };
}

/**
 * For each NFL team, the defence they face and how it ranks.
 *
 * Inverted from the rankings: FantasyPros says "LAR is ranked 3rd and plays
 * TEN", and a player card needs "TEN is facing a defence ranked 3rd". Returns
 * { [team]: { opponent, rank, of } }.
 */
export async function defenseMatchups(season, week) {
  let rows = await sql`
    select team, rank_ave, rank_ecr, opponent, week
    from defense_ranks where season = ${season} and week = ${week}`;

  // FantasyPros only publishes the CURRENT week, so a week that has not come
  // round yet has no rankings of its own. Fall back to the most recent week
  // that does: a defence's quality barely moves in seven days, and a stale
  // ranking is far more use than a blank card.
  let stale = false;
  if (!rows.length) {
    const [latest] = await sql`
      select max(week) as week from defense_ranks
      where season = ${season} and week < ${week}`;
    if (latest?.week == null) return {};
    rows = await sql`
      select team, rank_ave, rank_ecr, opponent, week
      from defense_ranks where season = ${season} and week = ${Number(latest.week)}`;
    stale = true;
  }
  if (!rows.length) return {};

  const of = rows.length;
  const byTeam = {};
  for (const r of rows) {
    byTeam[r.team] = {
      rank: r.rank_ecr == null ? null : Number(r.rank_ecr),
      rankAve: r.rank_ave == null ? null : Number(r.rank_ave),
    };
  }

  // The FIXTURES do move week to week, so a stale ranking must not carry a
  // stale opponent -- pairing week 1's rankings with week 1's opponents would
  // tell somebody they are playing a team they are not. Take this week's real
  // schedule and look each defence up in it.
  let fixtures = null;
  if (stale) {
    try {
      const { teamGameDates } = await import('./schedule.js');
      void teamGameDates; // schedule.js has the dates; the pairing needs opponents.
      const res = await fetch(`https://api.sleeper.com/schedule/nfl/regular/${season}`);
      if (res.ok) {
        const games = (await res.json()).filter((g) => g.week === week);
        if (games.length) {
          fixtures = {};
          for (const g of games) {
            fixtures[g.home] = g.away;
            fixtures[g.away] = g.home;
          }
        }
      }
    } catch {
      // No schedule, no fallback pairing. Better to show nothing than a wrong
      // opponent.
    }
    if (!fixtures) return {};
  }

  const out = {};
  for (const r of rows) {
    // Who this defence faces: the real fixture when the rankings are stale,
    // the one they shipped with otherwise.
    const facing = stale ? fixtures[r.team] : r.opponent;
    if (!facing) continue;
    // The OPPONENT is the one facing this defence.
    out[facing] = {
      opponent: r.team,
      rank: byTeam[r.team]?.rank ?? null,
      rankAve: byTeam[r.team]?.rankAve ?? null,
      of,
      // So the UI can say the ranking is not this week's.
      stale,
      rankedWeek: Number(r.week),
    };
  }
  return out;
}

/* ---------- drafts ---------- */

/**
 * Saves a half-finished lineup.
 *
 * A lineup takes nine taps to build and used to vanish on a refresh. This keeps
 * it, without pretending a partial lineup is an entry: no cap check, no
 * completeness check, no buy-in. The only things enforced are that the contest
 * is still open and that every id named is really in this week's pool -- a
 * draft full of junk would fail confusingly later rather than now.
 */
export async function saveDraft({ slug, contestId, slots }) {
  const [contest] = await sql`select * from dfs_contests where id = ${contestId}`;
  if (!contest) throw new Error('No such contest.');
  if (contest.status !== 'open') throw new Error('That contest has closed.');

  const pool = await salaryPool(contest.season, contest.week);
  const known = new Set(pool.map((p) => String(p.player_id)));
  const clean = (Array.isArray(slots) ? slots : []).map((id) =>
    id != null && known.has(String(id)) ? String(id) : null,
  );

  await sql`
    insert into dfs_drafts (contest_id, bettor, slots)
    values (${contestId}, ${slug}, ${JSON.stringify(clean)}::jsonb)
    on conflict (contest_id, bettor)
    do update set slots = ${JSON.stringify(clean)}::jsonb, updated_at = now()`;
  return { saved: clean.filter(Boolean).length };
}

/**
 * The lineup to show somebody when they open the builder.
 *
 * A submitted ENTRY wins over a draft: it is the lineup that actually counts,
 * and showing a stale draft over it would let somebody think they had changed
 * something they had not. Otherwise the draft, so a half-built lineup survives
 * a refresh.
 */
export async function lineupFor(slug, contestId) {
  const [entry] = await sql`
    select slots from dfs_entries where contest_id = ${contestId} and bettor = ${slug}`;
  if (entry) return { slots: entry.slots, entered: true };

  const [draft] = await sql`
    select slots from dfs_drafts where contest_id = ${contestId} and bettor = ${slug}`;
  return draft ? { slots: draft.slots, entered: false } : { slots: null, entered: false };
}

/** Clears a draft once it has become a real entry. */
export async function clearDraft(slug, contestId) {
  await sql`delete from dfs_drafts where contest_id = ${contestId} and bettor = ${slug}`;
}
