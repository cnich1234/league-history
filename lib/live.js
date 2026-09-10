import {
  liveProbability,
  liveSpreadProbability,
  liveTotalProbability,
  shouldSuspend,
  probabilityToOdds,
  maxLiveStake,
} from './odds.js';
import { SLEEPER_OWNERS } from './sleeper-owners.js';

/**
 * Live matchup state: what has been scored, what is still to come, and the
 * resulting win probability.
 *
 * The central quantity is "remaining projection" -- the sum of projections for
 * starters who have not scored yet. That is what drives the uncertainty, and
 * it is why a lead on Thursday means so much less than the same lead on Sunday.
 *
 * A player is treated as done once they have any points. That is cruder than
 * prorating by game clock, but Sleeper's matchup payload does not carry game
 * state, and the error is bounded: a player mid-game is counted as finished,
 * which understates remaining variance slightly and therefore closes markets a
 * little early. Erring toward closing early is the safe direction.
 */

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

/**
 * In-play margin, roughly double the 4.5% charged pre-game, matching industry
 * practice. Exported so the board and the placement path cannot drift: showing
 * one margin and charging another made the staleness guard fire on every bet.
 */
export const LIVE_MARGIN = 0.09;

const api = async (path) => {
  const r = await fetch(`https://api.sleeper.app/v1${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path} -> ${r.status}`);
  return r.json();
};

/** Per-game state, keyed by NFL team, for prorating players mid-game. */
async function loadGames(season, week) {
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

async function loadProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const byId = {};
  const teamById = {};
  for (const r of await res.json()) {
    if (!r.player_id) continue;
    if (typeof r?.stats?.pts_ppr === 'number') byId[r.player_id] = r.stats.pts_ppr;
    const team = r.player?.team ?? r.team;
    if (team) teamById[r.player_id] = team;
  }
  return { projections: byId, teamOfPlayer: teamById };
}

/**
 * How much of a player's game is left, from 1 (not kicked off) to 0 (final).
 *
 * A player mid-game is neither finished nor unstarted: two thirds through, a
 * third of their projection is still to come, and only that third carries
 * variance. Treating them as done the moment they score understates remaining
 * uncertainty and closes markets early; treating them as unstarted overstates
 * it and keeps a decided market open.
 *
 * Quarter granularity is what Sleeper exposes -- there is no game clock in the
 * payload -- so this steps 1, 0.75, 0.5, 0.25, 0. Coarse, but far better than
 * the binary it replaces.
 */
export function fractionRemaining(game) {
  if (!game) return 1;
  const m = game.metadata ?? {};
  if (game.status === 'complete' || m.is_over || m.closed) return 0;
  // Authoritative: a pre-game game has everything still to come, whatever the
  // quarter flags below say. Sleeper sets has1st_quarter_started on games that
  // have not kicked off.
  if (game.status === 'pre_game') return 1;
  if (!m.has_started && !m.is_in_progress) return 1;
  // Overtime is bonus scoring on top of a finished four quarters; treat it as
  // nearly over rather than as a fifth quarter of expected production.
  if (m.is_overtime) return 0.1;
  if (m.has4th_quarter_started) return 0.25;
  if (m.has3rd_quarter_started) return 0.5;
  if (m.has2nd_quarter_started) return 0.75;
  if (m.has1st_quarter_started) return 1;
  return 1;
}

/**
 * Scored and still-to-come totals for one lineup.
 *
 * `remaining` is what drives uncertainty, so a player who is halfway through
 * their game contributes only half their projection to it. Their points so far
 * are already in `scored` and carry no variance at all.
 */
function sides(matchup, projections, gameByTeam, teamOfPlayer) {
  const starters = (matchup?.starters ?? []).filter((id) => id && id !== '0');
  const points = matchup?.starters_points ?? [];

  let scored = 0;
  let remaining = 0;
  for (const [i, id] of starters.entries()) {
    scored += Number(points[i] ?? 0);
    const projection = projections[id] ?? 9;
    const left = fractionRemaining(gameByTeam[teamOfPlayer[id]]);
    remaining += projection * left;
  }
  return {
    scored: Math.round(scored * 10) / 10,
    remaining: Math.round(remaining * 10) / 10,
    // Points so far plus what is still expected -- the projected final.
    projected: Math.round((scored + remaining) * 10) / 10,
  };
}

/**
 * Live state for every matchup in a week.
 *
 * Returns a map keyed by "homeRoster-awayRoster" so markets can look up their
 * own matchup without another pass over the data.
 */
export async function liveMatchups(season, week) {
  const [users, rosters, matchups, proj, gameByTeam] = await Promise.all([
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
    loadProjections(season, week),
    loadGames(season, week),
  ]);
  const { projections, teamOfPlayer } = proj;

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));
  const nameOf = (rosterId) => {
    const r = rosterById[rosterId];
    const owner = SLEEPER_OWNERS[r?.owner_id];
    return userById[r?.owner_id]?.metadata?.team_name || owner?.name || `Roster ${rosterId}`;
  };

  const byMatchup = {};
  for (const m of matchups) (byMatchup[m.matchup_id] ??= []).push(m);

  const out = {};
  for (const pair of Object.values(byMatchup)) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const home = sides(a, projections, gameByTeam, teamOfPlayer);
    const away = sides(b, projections, gameByTeam, teamOfPlayer);

    // No projection left to come means every starter's game is final. This is
    // the signal that closes a live market, and it is deliberately the same
    // quantity the prices are built from: a market cannot still be quoted at a
    // number that says the game is over.
    const homeFinal = home.remaining === 0;
    const awayFinal = away.remaining === 0;

    const totalProjection = home.projected + away.projected;
    const remainingShare =
      totalProjection > 0 ? (home.remaining + away.remaining) / totalProjection : 0;
    const probability = liveProbability(home, away);

    // Live h2h price, so the UI can show what a bet would pay right now
    // without recomputing the model itself.
    const liveOdds = shouldSuspend(probability, remainingShare) == null
      ? {
          home: priceWithMargin(probability, LIVE_MARGIN),
          away: priceWithMargin(1 - probability, LIVE_MARGIN),
        }
      : null;

    out[`${a.roster_id}-${b.roster_id}`] = {
      homeRoster: a.roster_id,
      awayRoster: b.roster_id,
      homeName: nameOf(a.roster_id),
      awayName: nameOf(b.roster_id),
      home: { ...home, points: Number(a.points ?? 0), final: homeFinal },
      away: { ...away, points: Number(b.points ?? 0), final: awayFinal },
      probability,
      remainingShare: Math.round(remainingShare * 1000) / 1000,
      suspended: shouldSuspend(probability, remainingShare) != null,
      odds: liveOdds,
      // What the board may accept on this matchup right now. Recomputed per
      // market on placement, since a spread or total can be at a different
      // certainty than the matchup it belongs to.
      maxStakeCents: liveOdds ? maxLiveStake(probability) : null,
      // `home` and `away` above carry scored/remaining, which is everything a
      // client needs to price its own spread line. A function cannot cross the
      // JSON boundary, so the client recomputes from the same inputs using the
      // same shared model.
      started: Number(a.points ?? 0) > 0 || Number(b.points ?? 0) > 0,
    };
  }

  return { season, week, fetchedAt: new Date().toISOString(), matchups: out };
}

/**
 * Roster ids whose every starter's NFL game is final.
 *
 * This is what lets a live market close. `fractionRemaining` returning 0 for a
 * game is the same signal the pricing model uses, so a roster is finished
 * exactly when it has no variance left -- one source of truth for "over",
 * rather than a second opinion that could disagree with the prices on screen.
 *
 * A starter whose team cannot be identified counts as unfinished. Erring toward
 * "still playing" leaves a market open, where `shouldSuspend` still guards it;
 * erring the other way would settle a market mid-game.
 */
/**
 * NFL teams whose games have actually kicked off.
 *
 * `locks_at` is midnight Arizona on the morning of the game, which is early by
 * most of a day for a Thursday or Sunday night kickoff. That gap is what closed
 * a prop for a game still hours away and exposed the bet on The Floor. Kickoff
 * is a fact Sleeper reports, so this asks rather than infers.
 */
export async function kickedOffTeams(season, week) {
  const gameByTeam = await loadGames(season, week);
  const out = new Set();
  for (const [team, game] of Object.entries(gameByTeam)) {
    if (hasKickedOff(game)) out.add(team);
  }
  return out;
}

/**
 * Has this game actually started?
 *
 * Only `status`, `has_started` and `is_in_progress` are trustworthy here.
 * `has1st_quarter_started` is NOT: Sleeper had it set to true on SF@LAR while
 * the game was still `pre_game` with an empty quarter and kickoff eight hours
 * away. Believing it locked a prop -- and published the bet on The Floor --
 * before a ball was thrown.
 *
 * A quarter flag is fine for asking how FAR along a running game is, which is
 * what `fractionRemaining` uses it for. It is not evidence that a game began.
 */
export function hasKickedOff(game) {
  if (!game) return false;
  const m = game.metadata ?? {};
  if (game.status === 'complete' || m.is_over || m.closed) return true;
  if (game.status === 'pre_game') return false;
  return Boolean(m.has_started || m.is_in_progress);
}

export function finishedRostersIn(state) {
  const done = [];
  for (const m of Object.values(state?.matchups ?? {})) {
    if (m.home.final) done.push(m.homeRoster);
    if (m.away.final) done.push(m.awayRoster);
  }
  return done;
}

/**
 * Finds a market's matchup state.
 *
 * h2h and spread carry both rosters and can key the map directly. A team total
 * carries only its own `rosterId`, so it has to be searched for -- building a
 * key from its missing homeRoster produced "undefined-undefined", found
 * nothing, and suspended every total while the board still showed prices.
 */
export function stateForMarket(market, matchups) {
  const meta = market.meta ?? {};
  if (meta.homeRoster != null && meta.awayRoster != null) {
    return matchups[`${meta.homeRoster}-${meta.awayRoster}`] ?? null;
  }
  if (meta.rosterId != null) {
    return (
      Object.values(matchups).find(
        (v) => v.homeRoster === meta.rosterId || v.awayRoster === meta.rosterId,
      ) ?? null
    );
  }
  return null;
}

/**
 * Live price for one market, or null if it should not be quoted.
 *
 * The vig is deliberately wider than pre-game. Industry hold roughly doubles
 * in-play (4-6% becomes 7-12%) for a mechanical reason: as the remaining
 * standard deviation shrinks, a fixed percentage margin is a smaller and
 * smaller absolute cushion, while a bettor's timing advantage does not shrink
 * at all.
 */
export function livePrice(market, state, { margin = LIVE_MARGIN } = {}) {
  if (!state || state.suspended) return null;

  let pHome;
  if (market.kind === 'h2h') {
    pHome = state.probability;
  } else if (market.kind === 'spread') {
    // Both slugs must be present. Comparing against an undefined homeSlug is
    // always false, which silently priced every spread with the away team as
    // the favourite -- a bug that made covering look easier than winning.
    if (!market.meta.homeSlug || !market.meta.favouriteSlug) {
      throw new Error(`Spread market ${market.id ?? ''} is missing homeSlug or favouriteSlug.`);
    }
    const favIsHome = market.meta.favouriteSlug === market.meta.homeSlug;
    const fav = favIsHome ? state.home : state.away;
    const dog = favIsHome ? state.away : state.home;
    const pCover = liveSpreadProbability(fav, dog, market.meta.spread);
    return {
      cover: priceWithMargin(pCover, margin),
      nocover: priceWithMargin(1 - pCover, margin),
      probability: pCover,
      maxStakeCents: maxLiveStake(pCover),
    };
  } else if (market.kind === 'total') {
    // A team total depends only on that lineup, so it is suspended on its own
    // remaining share rather than the matchup's.
    const side = market.meta.rosterId === state.homeRoster ? state.home : state.away;
    const own = side.remaining / (side.scored + side.remaining || 1);
    const pOver = liveTotalProbability(side, market.meta.line);
    if (shouldSuspend(pOver, own) != null) return null;
    return {
      over: priceWithMargin(pOver, margin),
      under: priceWithMargin(1 - pOver, margin),
      probability: pOver,
      maxStakeCents: maxLiveStake(pOver),
    };
  } else {
    return null;
  }

  return {
    home: priceWithMargin(pHome, margin),
    away: priceWithMargin(1 - pHome, margin),
    probability: pHome,
    maxStakeCents: maxLiveStake(pHome),
  };
}

function priceWithMargin(p, margin) {
  // Split the margin across both sides, and never quote past 97% -- beyond
  // that the price is meaningless and the market should have closed.
  return probabilityToOdds(Math.min(0.97, p + margin / 2));
}
