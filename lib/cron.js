import { readFileSync, existsSync } from 'node:fs';
import { h2hProbability, twoWayOdds, fieldOdds, LEAGUE_SD } from './odds.js';
import { teamGameDates, lockTimeFor, latestKickoff } from './schedule.js';
import { resolveMarket } from './settle.js';
import { settleMarket } from './book.js';
import { SLEEPER_OWNERS } from './sleeper-owners.js';
import { expectedLineup, replacementTable, DEFAULT_SLOTS } from './lineup.js';
import { isScratched } from './scratched.js';

/**
 * Market building and settling, callable from a serverless function.
 *
 * The CLI scripts do the same work, but they read the 15MB Sleeper player file
 * from disk and take `process.argv`. Neither survives a deploy, so the logic
 * lives here and the scripts stay as the manual escape hatch.
 */

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

/**
 * P(margin < x) for a matchup, in points.
 *
 * Blowout markets need the probability of each TAIL separately -- "wins by more
 * than 20" for each side -- which h2hProbability cannot express, since it only
 * answers "who wins". Same distribution: the difference of two lineup scores,
 * sd = LEAGUE_SD * sqrt(2).
 */
function normalCdfFor(points) {
  const z = points / (LEAGUE_SD * Math.SQRT2) / Math.SQRT2;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

const api = async (path) => {
  const r = await fetch(`https://api.sleeper.app/v1${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path} -> ${r.status}`);
  return r.json();
};

/**
 * Position and NFL team for the players on a roster.
 *
 * The full Sleeper player file is ~15MB and cannot ship in a serverless bundle,
 * so this reads the slim public/players.json the live view already uses and
 * falls back to fetching only what is missing.
 */
async function loadPlayerIndex() {
  const local = 'public/players.json';
  if (existsSync(local)) {
    try {
      const slim = JSON.parse(readFileSync(local, 'utf8'));
      // The slim file has name and position but not NFL team, which lock times
      // need. Fetch teams separately -- one small request, not fifteen megabytes.
      return slim;
    } catch {}
  }
  return {};
}

async function loadProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const byId = {};
  const teamById = {};
  const positionById = {};
  const injuryById = {};
  const nameById = {};
  for (const r of await res.json()) {
    if (!r.player_id) continue;
    if (typeof r?.stats?.pts_ppr === 'number') byId[r.player_id] = r.stats.pts_ppr;
    // The projections payload carries the player's team, which is all the lock
    // calculation needs -- no separate player file required.
    if (r?.player?.team) teamById[r.player_id] = r.player.team;
    else if (r?.team) teamById[r.player_id] = r.team;
    // And his position, which the slim player file lacks for free agents.
    if (r?.player?.position) positionById[r.player_id] = r.player.position;
    if (r?.player?.injury_status) injuryById[r.player_id] = r.player.injury_status;
    // And his name. The slim player file is a snapshot of the rosters on the
    // day it was built, so anyone picked up since came out as a bare id --
    // "7523 over/under 21" on week 3's board was Trevor Lawrence.
    const name = [r?.player?.first_name, r?.player?.last_name].filter(Boolean).join(' ');
    if (name) nameById[r.player_id] = name;
  }
  return {
    projections: byId,
    teams: teamById,
    positions: positionById,
    injuries: injuryById,
    names: nameById,
  };
}

const BASELINE = { QB: 16, RB: 10, WR: 9, TE: 7, K: 8, DEF: 7 };

/**
 * The lowest projection worth posting a prop on.
 *
 * Below this the line lands at 0.5 or 1.5 and the bet stops being about
 * football: it is "did this person dress", which anyone reading an injury
 * report wins for free. A bye week projects zero and is caught by the same
 * floor. 3 keeps the deep bench out while leaving genuine flier picks in.
 */
const PROP_FLOOR = 3;

/**
 * What makes two markets the SAME market, whatever their line.
 *
 * The title used to be the key, and most titles carry a line -- "Josh Allen
 * over/under 22.5", "Hot Dogs -7.5 vs Brisket". Rebuild after the projections
 * move and every such title is new, so a rerun added a second prop on the same
 * player at a different price beside the first (47 of them mid-week 1). Keyed
 * on who and what instead, a rerun can only ever fill in what is missing.
 *
 * Matchup keys sort the two rosters, so a feed that lists the pair the other
 * way round is still the same game. Anything without the fields falls back to
 * kind and title, which is what the old check did.
 */
export function marketIdentity({ kind, title, meta }) {
  const m = meta ?? {};
  const pair = [m.homeRoster, m.awayRoster].map(String).sort().join('-');
  const hasPair = m.homeRoster != null && m.awayRoster != null;
  if (kind === 'prop' && m.playerId != null) return `prop:${m.playerId}`;
  if (kind === 'total' && m.rosterId != null) return `total:${m.rosterId}`;
  if (kind === 'h2h' && hasPair) return `h2h:${pair}`;
  if (kind === 'spread' && hasPair) {
    return m.blowout ? `blowout:${pair}:${m.spread}` : `spread:${pair}`;
  }
  if (kind === 'showdown' && hasPair && m.position) return `showdown:${m.position}:${pair}`;
  return `${kind}:${title}`;
}

/**
 * Writes a week's planned markets and their options in ONE statement.
 *
 * One statement is one transaction, so a board is either all there or not
 * there at all. Market by market, a run killed at its time limit left a board
 * that looked built -- the cron's "does this week have markets" gate said yes
 * -- with the rest missing for good. Now a killed run writes nothing and the
 * next scheduled run builds the lot. It is also one round trip instead of
 * several hundred, which is most of why the old way ran out of time.
 *
 * Markets already on the board, by marketIdentity, are skipped rather than
 * repriced: someone may have bet at the old line.
 *
 * `dryRun` reports what would be written and writes nothing.
 */
export async function writeBoard(sql, season, week, planned, { dryRun = false } = {}) {
  const existing = await sql`
    select kind, title, meta from markets where season = ${season} and week = ${week}`;
  const have = new Set(existing.map(marketIdentity));
  const fresh = [];
  for (const p of planned) {
    const id = marketIdentity(p);
    if (have.has(id)) continue;
    have.add(id);
    fresh.push(p);
  }
  const skipped = planned.length - fresh.length;
  if (dryRun || !fresh.length) return { created: 0, skipped, planned: fresh };

  // Options find their market by kind, title and meta together, which
  // marketIdentity has just made unique within the batch.
  const [row] = await sql`
    with input as (
      select m, ord
      from jsonb_array_elements(${JSON.stringify(fresh)}::jsonb) with ordinality as t(m, ord)
    ), ins as (
      insert into markets (season, week, kind, title, subtitle, locks_at, live, meta)
      select ${season}, ${week}, m->>'kind', m->>'title', m->>'subtitle',
             (m->>'locksAt')::timestamptz, (m->>'live')::boolean, m->'meta'
      from input order by ord
      returning id, kind, title, meta
    ), opts as (
      insert into market_options (market_id, option_key, label, odds)
      select ins.id, o->>'key', o->>'label', (o->>'odds')::int
      from ins
      join input on input.m->>'kind' = ins.kind
                and input.m->>'title' = ins.title
                and input.m->'meta' = ins.meta
      cross join lateral jsonb_array_elements(input.m->'options') o
      returning market_id
    )
    select (select count(*) from ins)::int as markets, (select count(*) from opts)::int as options`;
  return { created: row.markets, options: row.options, skipped };
}

/**
 * Builds the week's markets. Existing markets are left untouched.
 *
 * `dryRun` fetches and prices everything, then returns what it would add
 * without writing it.
 */
export async function buildWeek(sql, season, week, { dryRun = false } = {}) {
  const [league, users, rosters, matchups] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
  ]);

  if (!matchups?.length) return { created: 0, skipped: 0, note: 'no matchups' };

  const [
    { projections, teams: nflTeams, positions: feedPositions, injuries: feedInjuries, names: feedNames },
    gameDates,
    slim,
  ] = await Promise.all([
    loadProjections(season, week),
    teamGameDates(season, week),
    loadPlayerIndex(),
  ]);

  // A market that belongs to no single game falls back to the week's last
  // kickoff rather than its last midnight.
  const fallbackLock = latestKickoff(gameDates) ?? new Date(Date.now() + 86400e3);

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

  const positionOf = (id) => slim[id]?.p ?? feedPositions[id] ?? '?';
  const nameOf = (id) => slim[id]?.n ?? feedNames[id] ?? String(id);
  /**
   * What a player is projected to score this week. Zero on a bye.
   *
   * Falling through to BASELINE for a bye player inflated every line they
   * touched -- a team total set 9 points too high, and a spread skewed toward
   * whichever side had fewer teams resting. Byes start in week 5 and hit four
   * or five teams at a time, so this is most of the season.
   *
   * `gameDates` covers every team with a game this week, so a rostered player
   * whose team is absent from it is on a bye. A player with no identifiable
   * team still gets the baseline rather than zero, since that is ignorance
   * rather than evidence of a bye.
   */
  const projectPlayer = (id) => {
    const team = nflTeams[id];
    if (team && !gameDates[team]) return 0;
    return projections[id] ?? BASELINE[positionOf(id)] ?? 7;
  };
  /**
   * The lineup a roster is priced on: the best it can field, not what is set.
   * Boards are built on Tuesday when half the league has not touched a
   * lineup, and a set lineup is a lever anyway (see lib/lineup.js). Nothing
   * has kicked off at build time, so every slot is open.
   */
  const slots = Array.isArray(league?.roster_positions) && league.roster_positions.length
    ? league.roster_positions
    : DEFAULT_SLOTS;
  const rostered = new Set(rosters.flatMap((r) => (r.players ?? []).map(String)));
  // A slot nobody on a roster can fill is worth the best of the waiver wire.
  const replacement = replacementTable({
    ids: Object.keys(projections),
    rostered,
    positionOf: (id) => (positionOf(id) === '?' ? null : positionOf(id)),
    projectionOf: projectPlayer,
  });
  const lineupEntries = (m) =>
    expectedLineup(m, {
      slots,
      positionOf: (id) => (positionOf(id) === '?' ? null : positionOf(id)),
      projectionOf: projectPlayer,
      kickedOff: () => false,
      unavailable: new Set(
        [...(rosterById[m.roster_id]?.reserve ?? []), ...(rosterById[m.roster_id]?.taxi ?? [])].map(String),
      ),
      replacement,
    });
  const lineupOf = (m) => lineupEntries(m).map((e) => e.id).filter(Boolean);
  const teamsOf = (m) => lineupOf(m).map((id) => nflTeams[id]).filter(Boolean);
  const projectTeam = (m) =>
    Math.round(
      lineupEntries(m).reduce((sum, e) => sum + (e.id ? projectPlayer(e.id) : e.replacement), 0) * 10,
    ) / 10;

  const teamOf = (rosterId) => {
    const r = rosterById[rosterId];
    const owner = SLEEPER_OWNERS[r?.owner_id];
    if (!owner) return null;
    const u = userById[r.owner_id];
    return { slug: owner.slug, name: owner.name, team: u?.metadata?.team_name || owner.name };
  };

  /**
   * Which kinds keep trading once games start.
   *
   * This was set by migrations 008 and 009 and never here, so every week built
   * after those ran came out entirely non-live -- week 2's matchups and spreads
   * would have shut at kickoff instead of repricing. The rule belongs with the
   * markets it describes.
   *
   * A blowout is the exception among spreads: it is a three-outcome field keyed
   * by roster id, and the live spread model does not describe it, so it stays
   * pregame rather than being quoted as something it is not.
   */
  const isLive = ({ kind, meta }) =>
    (kind === 'h2h' || kind === 'total' || (kind === 'spread' && !meta?.blowout));

  // Collected, not written. The whole board goes in as ONE statement at the
  // end (see writeBoard), because writing it market by market left week 3 of
  // 2026 half-built: the cron hit its time limit 120 markets in, before the
  // specials, and every later run saw "week 3 has markets" and skipped it.
  const planned = [];
  async function createMarket({ kind, title, subtitle, meta, options, locksAt }) {
    planned.push({ kind, title, subtitle, meta, options, locksAt, live: isLive({ kind, meta }) });
  }

  const byMatchup = {};
  for (const m of matchups) (byMatchup[m.matchup_id] ??= []).push(m);

  for (const pair of Object.values(byMatchup)) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const home = teamOf(a.roster_id);
    const away = teamOf(b.roster_id);
    if (!home || !away) continue;

    const projHome = projectTeam(a);
    const projAway = projectTeam(b);
    const { home: oddsHome, away: oddsAway } = twoWayOdds(h2hProbability(projHome, projAway));
    const matchupLock = lockTimeFor([...teamsOf(a), ...teamsOf(b)], gameDates, fallbackLock);

    await createMarket({
      kind: 'h2h',
      title: `${home.team} vs ${away.team}`,
      subtitle: 'Who wins the matchup',
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        awaySlug: away.slug,
      },
      locksAt: matchupLock,
      options: [
        { key: 'home', label: home.team, odds: oddsHome },
        { key: 'away', label: away.team, odds: oddsAway },
      ],
    });

    const raw = Math.round((projHome - projAway) * 2) / 2;
    const spread = Number.isInteger(raw) ? raw + 0.5 : raw;
    const favourite = spread >= 0 ? home : away;
    const underdog = spread >= 0 ? away : home;
    const abs = Math.abs(spread);
    await createMarket({
      kind: 'spread',
      title: `${favourite.team} -${abs} vs ${underdog.team}`,
      subtitle: `Does ${favourite.team} win by more than ${abs}?`,
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        favouriteSlug: favourite.slug,
        underdogSlug: underdog.slug,
        spread: abs,
      },
      locksAt: matchupLock,
      options: [
        { key: 'cover', label: `${favourite.team} -${abs}`, odds: -110 },
        { key: 'nocover', label: `${underdog.team} +${abs}`, odds: -110 },
      ],
    });

    // Blowout markets: "does EITHER team win by more than the line", one option
    // per manager.
    //
    // Three outcomes, not two -- the third is a close game, where BOTH sides
    // lose. That is what lets both be priced at plus money: "neither" is the
    // likeliest result by far (37-56% depending on the line), and it pays out
    // nothing.
    //
    // Which is exactly why twoWayOdds is wrong here. It splits a margin across
    // two outcomes that sum to 1; these two sum to well under 1, and pricing
    // them as a pair would quote both sides far too short. fieldOdds prices a
    // field of any size, and here the field includes the outcome nobody can
    // back.
    for (const line of [20.5, 30.5]) {
      const pHome = 1 - normalCdfFor(line - (projHome - projAway));
      const pAway = normalCdfFor(-line - (projHome - projAway));
      // Nothing anyone would take, and nothing worth the row on a phone.
      if (pHome < 0.03 && pAway < 0.03) continue;

      // The unbackable outcome is a real part of the book and has to be in the
      // weights, or the two prices would be normalised against each other and
      // come out far too short.
      const neither = Math.max(0, 1 - pHome - pAway);
      const priced = fieldOdds({
        [a.roster_id]: pHome,
        [b.roster_id]: pAway,
        nobody: neither,
      });

      await createMarket({
        kind: 'spread',
        // The matchup has to be in the title: createMarket dedupes on
        // season+week+kind+title, so "Does either team win by more than 20.5?"
        // alone collapsed all five games into one market.
        title: `${home.team} vs ${away.team}: either team by ${line}+?`,
        subtitle: `Does either side win by more than ${line}? A close game loses both.`,
        meta: {
          homeRoster: a.roster_id,
          awayRoster: b.roster_id,
          homeSlug: home.slug,
          awaySlug: away.slug,
          spread: line,
          blowout: true,
          alternate: true,
        },
        locksAt: matchupLock,
        options: [
          { key: String(a.roster_id), label: `${home.team} by ${line}+`, odds: priced[a.roster_id] },
          { key: String(b.roster_id), label: `${away.team} by ${line}+`, odds: priced[b.roster_id] },
        ],
      });
    }

    // Positional showdowns: one lineup's starters at a position against the
    // other's. Uses the same normal model, but with a standard deviation scaled
    // to the position group rather than the whole lineup -- three WRs swing far
    // less than a full roster does.
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const groupOf = (matchup) => lineupOf(matchup).filter((id) => positionOf(id) === pos);

      const homeGroup = groupOf(a);
      const awayGroup = groupOf(b);
      // A showdown needs both sides to field someone, or it can only ever void.
      if (!homeGroup.length || !awayGroup.length) continue;

      const projGroupHome = homeGroup.reduce((sum, id) => sum + projectPlayer(id), 0);
      const projGroupAway = awayGroup.reduce((sum, id) => sum + projectPlayer(id), 0);

      // Per-player SD, scaled by how many players are in the group. LEAGUE_SD
      // is for a whole nine-man lineup, so applying it to a single TE would
      // price every showdown as a coin flip.
      const players = Math.max(homeGroup.length, awayGroup.length);
      const groupSd = (LEAGUE_SD / 3) * Math.sqrt(players);

      const rawEdge = Math.round((projGroupHome - projGroupAway) * 2) / 2;
      const edge = Number.isInteger(rawEdge) ? rawEdge + 0.5 : rawEdge;
      const favIsHome = edge >= 0;
      const favTeam = favIsHome ? home : away;
      const dogTeam = favIsHome ? away : home;
      const line = Math.abs(edge);

      const pCover = h2hProbability(
        favIsHome ? projGroupHome : projGroupAway,
        (favIsHome ? projGroupAway : projGroupHome) + line,
        groupSd,
      );
      const priced = twoWayOdds(pCover);

      await createMarket({
        kind: 'showdown',
        title: `${favTeam.team} ${pos}s -${line} vs ${dogTeam.team} ${pos}s`,
        subtitle: `Do ${favTeam.team}'s starting ${pos}s outscore ${dogTeam.team}'s by more than ${line}?`,
        meta: {
          position: pos,
          homeRoster: a.roster_id,
          awayRoster: b.roster_id,
          homeSlug: home.slug,
          awaySlug: away.slug,
          favouriteSide: favIsHome ? 'home' : 'away',
          favouriteSlug: favTeam.slug,
          underdogSlug: dogTeam.slug,
          spread: line,
        },
        // A positional showdown depends only on THAT position's starters, so
        // it locks on their kickoffs -- not on the matchup's, which is dragged
        // early by whichever player happens to play first. A QB battle where
        // neither quarterback plays Thursday has no business closing Thursday.
        locksAt: lockTimeFor(
          [...groupOf(a), ...groupOf(b)].map((id) => nflTeams[id]).filter(Boolean),
          gameDates,
          matchupLock,
        ),
        options: [
          { key: 'cover', label: `${favTeam.team} ${pos}s -${line}`, odds: priced.home },
          { key: 'nocover', label: `${dogTeam.team} ${pos}s +${line}`, odds: priced.away },
        ],
      });
    }

    for (const [side, team, proj, rosterId, matchup] of [
      ['home', home, projHome, a.roster_id, a],
      ['away', away, projAway, b.roster_id, b],
    ]) {
      const line = Math.round(proj * 2) / 2 + 0.5;
      await createMarket({
        kind: 'total',
        title: `${team.team} over/under ${line}`,
        subtitle: `Does ${team.team} score more than ${line}?`,
        meta: { rosterId, slug: team.slug, line, side },
        locksAt: lockTimeFor(teamsOf(matchup), gameDates, fallbackLock),
        options: [
          { key: 'over', label: `Over ${line}`, odds: -110 },
          { key: 'under', label: `Under ${line}`, odds: -110 },
        ],
      });
    }
  }

  // A prop for every skill starter, so anyone can bet anyone on their roster.
  // Kickers and defences are skipped: their scoring is close to a coin flip, so
  // the line carries no information and nobody wants to bet it.
  const candidates = [];
  for (const m of matchups) {
    const team = teamOf(m.roster_id);
    if (!team) continue;
    const starting = new Set((m.starters ?? []).filter((x) => x && x !== '0'));
    // EVERY rostered skill player, not just the ones in the lineup. A bench
    // player is exactly as bettable as a starter -- and betting on whether
    // somebody's benched sleeper outscores their starter is the more
    // interesting question.
    for (const id of (m.players ?? []).filter((x) => x && x !== '0')) {
      const pos = positionOf(id);
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;

      const projection = projectPlayer(id);
      // A player projected at zero is on a bye, hurt, or inactive. At the
      // usual line that becomes "over/under 0.5" at -110 each way, which is
      // not a bet -- it is free money for whoever read the injury report.
      // Skip them rather than post a trap.
      if (projection < PROP_FLOOR) continue;
      // And explicitly skip anyone already ruled out, whatever the projection
      // says. The feed can still carry a healthy number for a man who was
      // ruled out after it was computed. Anyone ruled out LATER is caught by
      // the per-minute sweep in lib/scratched.js, which voids the market.
      if (isScratched(feedInjuries?.[id])) continue;

      candidates.push({
        playerId: id,
        name: nameOf(id),
        position: pos,
        rosterId: m.roster_id,
        slug: team.slug,
        team: team.team,
        nflTeam: nflTeams[id],
        projection,
        benched: !starting.has(id),
      });
    }
  }
  candidates.sort((x, y) => y.projection - x.projection);

  for (const p of candidates) {
    const line = Math.round(p.projection * 2) / 2 + 0.5;
    await createMarket({
      kind: 'prop',
      title: `${p.name} over/under ${line}`,
      subtitle: `${p.position} · ${p.benched ? 'benched by' : 'started by'} ${p.team}`,
      meta: {
        playerId: p.playerId,
        playerName: p.name,
        position: p.position,
        rosterId: p.rosterId,
        slug: p.slug,
        line,
        nflTeam: p.nflTeam,
        benched: p.benched,
      },
      locksAt: lockTimeFor([p.nflTeam], gameDates, fallbackLock),
      options: [
        { key: 'over', label: `Over ${line}`, odds: -110 },
        { key: 'under', label: `Under ${line}`, odds: -110 },
      ],
    });
  }

  // League-wide "best in the league this week" markets. One market, one option
  // per manager -- unlike everything else on the board, these belong to no
  // matchup, which is why they get their own section rather than a game card.
  //
  // They are team bets: if your roster started the top RB, your option wins.
  const specials = [
    { key: 'team', title: 'Highest scoring team', subtitle: 'Most points in the league this week' },
    { key: 'RB', title: 'Highest scoring RB', subtitle: 'Best starting RB in the league' },
    { key: 'WR', title: 'Highest scoring WR', subtitle: 'Best starting WR in the league' },
    { key: 'TE', title: 'Highest scoring TE', subtitle: 'Best starting TE in the league' },
  ];

  for (const spec of specials) {
    // Weight each roster by what it is projected to bring to this question --
    // its whole lineup for the team market, its best starter at that position
    // otherwise. A roster with no starter at the position is left out entirely
    // rather than priced as a longshot it cannot win.
    const weights = {};
    const labels = {};
    for (const m of matchups) {
      const team = teamOf(m.roster_id);
      if (!team) continue;
      const starters = lineupOf(m);

      let weight;
      if (spec.key === 'team') {
        weight = projectTeam(m);
      } else {
        const atPosition = starters
          .filter((id) => positionOf(id) === spec.key)
          .map((id) => projectPlayer(id));
        if (!atPosition.length) continue;
        weight = Math.max(...atPosition);
      }
      if (!(weight > 0)) continue;
      weights[m.roster_id] = weight;
      labels[m.roster_id] = team.team;
    }

    const rosterIds = Object.keys(weights);
    // Needs a real field. Two managers is not a market worth pricing.
    if (rosterIds.length < 3) continue;

    const prices = fieldOdds(weights);
    await createMarket({
      kind: 'special',
      title: spec.title,
      subtitle: spec.subtitle,
      meta: {
        special: spec.key === 'team' ? 'team' : 'position',
        ...(spec.key === 'team' ? {} : { position: spec.key }),
      },
      // Every lineup in the league is involved, so this locks at the EARLIEST
      // kickoff of the week, not the latest. fallbackLock is the last game day
      // and would have left it bettable after the answer was half known.
      locksAt: lockTimeFor(Object.keys(gameDates), gameDates, fallbackLock),
      options: rosterIds.map((id) => ({
        key: String(id),
        label: labels[id],
        odds: prices[id],
      })),
    });
  }

  return writeBoard(sql, season, week, planned, { dryRun });
}

/**
 * The scoring inputs resolveMarket needs, gathered from Sleeper.
 *
 * Split out of settleWeek so a read-only caller can ask "how would this settle
 * right now" without settling anything. Returns null when the week has no
 * scores yet, which is the honest answer before kickoff.
 */
export async function scoringInputs(season, week) {
  const matchups = await api(`/league/${LEAGUE_ID}/matchups/${week}`);
  if (!matchups?.some((m) => m.points > 0)) return null;

  const pointsByRoster = {};
  const pointsByPlayer = {};
  const startedPlayers = new Set();
  const starterRosters = {};
  for (const m of matchups) {
    pointsByRoster[m.roster_id] = Number(m.points ?? 0);
    for (const [pid, pts] of Object.entries(m.players_points ?? {})) {
      pointsByPlayer[pid] = Math.max(pointsByPlayer[pid] ?? 0, Number(pts ?? 0));
    }
    const points = m.starters_points ?? [];
    for (const [i, id] of (m.starters ?? []).entries()) {
      if (!id || id === '0') continue;
      startedPlayers.add(id);
      starterRosters[id] = { rosterId: m.roster_id, points: Number(points[i] ?? 0) };
    }
  }

  let positionOf = () => '?';
  try {
    const slim = await loadPlayerIndex();
    positionOf = (id) => slim[id]?.p ?? '?';
  } catch {
    /* positional specials resolve to void, same as settlement */
  }

  return { pointsByRoster, pointsByPlayer, startedPlayers, starterRosters, positionOf };
}

/**
 * Settles a week's markets from final scores. Already-settled markets are skipped.
 *
 * `inputs` overrides the scores rather than reading Sleeper, so a test can
 * settle a week the feed has never heard of. Production passes nothing.
 */
export async function settleWeek(sql, season, week, { inputs = null } = {}) {
  const scores = inputs ?? (await scoringInputs(season, week));
  if (!scores) return { settled: 0, voided: 0, note: 'no scores' };
  const { pointsByRoster, pointsByPlayer, startedPlayers, starterRosters, positionOf } = scores;

  const markets = await sql`
    select id, kind, title, status, meta from markets
    where season = ${season} and week = ${week} and status not in ('settled', 'void')`;

  let settled = 0;
  let voided = 0;

  // Which markets actually have money on them. settleMarket does a dozen
  // queries per market -- bets, boosts, thieves, tithes, bounties, legs -- and
  // for a market nobody backed every one of them returns nothing.
  //
  // Week 2 had 176 markets and 48 with a bet or a leg. At ~1.8s each the run
  // needed five and a half minutes against a 60s function limit, so the cron
  // was killed after 32 markets and never reached daily fantasy, the
  // allowance or trophies. Settling the empty ones in one statement takes the
  // run from minutes to seconds.
  const ids = markets.map((m) => Number(m.id));
  const backed = new Set(
    (
      await sql`
        select distinct market_id from (
          select market_id from bets where market_id = any(${ids}) and status = 'pending'
          union all
          select l.market_id from parlay_legs l join bets b on b.id = l.bet_id
          where l.market_id = any(${ids}) and b.status = 'pending'
        ) x`
    ).map((r) => Number(r.market_id)),
  );

  // An outcome per market, resolved once.
  const outcomes = new Map();
  for (const m of markets) {
    const outcome = resolveMarket(m, {
      pointsByRoster,
      pointsByPlayer,
      startedPlayers,
      starterRosters,
      positionOf,
    });
    if (outcome != null) outcomes.set(Number(m.id), outcome);
  }

  // The ones with money go through settleMarket, which pays, refunds, cancels
  // bounties and resolves parlay legs. Nothing about that is skippable.
  for (const [id, outcome] of outcomes) {
    if (!backed.has(id)) continue;
    await settleMarket(id, outcome);
    if (outcome === 'void') voided++;
    else settled++;
  }

  // The rest carry no bets, so there is nothing to pay and nothing to cancel:
  // recording the result is the whole job. Grouped by outcome so it is a
  // handful of statements rather than one per market.
  const byOutcome = new Map();
  for (const [id, outcome] of outcomes) {
    if (backed.has(id)) continue;
    if (!byOutcome.has(outcome)) byOutcome.set(outcome, []);
    byOutcome.get(outcome).push(id);
  }
  for (const [outcome, list] of byOutcome) {
    await sql`
      update markets
      set status = ${outcome === 'void' ? 'void' : 'settled'},
          winning_option = ${outcome},
          settled_at = now()
      where id = any(${list}) and status not in ('settled', 'void')`;
    if (outcome === 'void') voided += list.length;
    else settled += list.length;
  }

  return { settled, voided };
}

/* ---------- which week is finished ---------- */

/**
 * The first week that counts. Everything before it was preseason -- week 1
 * of 2026 was played as a test and wiped on 2026-09-14 -- and is never
 * settled, scored or paid, no matter how finished it is. Without this the
 * cron would have re-scored the wiped week at its next run and handed the
 * test trophies straight back.
 */
export const FIRST_WEEK = Number(process.env.BOOK_FIRST_WEEK ?? 2);

/**
 * True when every game of a week is final. An empty list is not a finished
 * week, it is a feed that said nothing.
 */
export function weekIsFinished(games) {
  const arr = Array.isArray(games) ? games : Object.values(games ?? {});
  if (!arr.length) return false;
  return arr.every((g) => g?.status === 'complete' || g?.metadata?.is_over === true);
}

/**
 * The last week that is actually FINISHED, or null when none is.
 *
 * Sleeper advances `week` some hours after the Monday game, at a time of its
 * own choosing. Keying settlement to that flip meant a run just after Monday
 * night could skip the whole week's payouts and not try again for a day. So
 * the current week counts as finished the moment every one of its games is
 * final, whether or not Sleeper has moved on; before that, `week - 1` is
 * finished when there is one. Week 1 with games still to play is nothing:
 * "no completed week yet" is not week 1, and every week-keyed step skips.
 */
export async function completedWeek(season, week, { games = null } = {}) {
  let rows = games;
  if (rows == null) {
    try {
      const res = await fetch(`https://api.sleeper.com/scores/nfl/regular/${season}/${week}`);
      rows = res.ok ? await res.json() : [];
    } catch {
      rows = [];
    }
  }
  const finished = weekIsFinished(rows) ? week : week > 1 ? week - 1 : null;
  return finished != null && finished >= FIRST_WEEK ? finished : null;
}
