import { liveProbability, liveSpreadProbability, shouldSuspend, probabilityToOdds } from './odds.js';
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

const api = async (path) => {
  const r = await fetch(`https://api.sleeper.app/v1${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path} -> ${r.status}`);
  return r.json();
};

async function loadProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const byId = {};
  for (const r of await res.json()) {
    if (r.player_id && typeof r?.stats?.pts_ppr === 'number') byId[r.player_id] = r.stats.pts_ppr;
  }
  return byId;
}

/** Scored and still-to-come totals for one lineup. */
function sides(matchup, projections) {
  const starters = (matchup?.starters ?? []).filter((id) => id && id !== '0');
  const points = matchup?.starters_points ?? [];

  let scored = 0;
  let remaining = 0;
  for (const [i, id] of starters.entries()) {
    const got = Number(points[i] ?? 0);
    if (got > 0) scored += got;
    else remaining += projections[id] ?? 9;
  }
  return {
    scored: Math.round(scored * 10) / 10,
    remaining: Math.round(remaining * 10) / 10,
    // Whole-lineup total, for display next to the live score.
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
  const [users, rosters, matchups, projections] = await Promise.all([
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
    loadProjections(season, week),
  ]);

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
    const home = sides(a, projections);
    const away = sides(b, projections);

    const totalProjection = home.projected + away.projected;
    const remainingShare =
      totalProjection > 0 ? (home.remaining + away.remaining) / totalProjection : 0;
    const probability = liveProbability(home, away);

    out[`${a.roster_id}-${b.roster_id}`] = {
      homeRoster: a.roster_id,
      awayRoster: b.roster_id,
      homeName: nameOf(a.roster_id),
      awayName: nameOf(b.roster_id),
      home: { ...home, points: Number(a.points ?? 0) },
      away: { ...away, points: Number(b.points ?? 0) },
      probability,
      remainingShare: Math.round(remainingShare * 1000) / 1000,
      suspended: shouldSuspend(probability, remainingShare) != null,
      started: Number(a.points ?? 0) > 0 || Number(b.points ?? 0) > 0,
    };
  }

  return { season, week, fetchedAt: new Date().toISOString(), matchups: out };
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
export function livePrice(market, state, { margin = 0.09 } = {}) {
  if (!state || state.suspended) return null;

  let pHome;
  if (market.kind === 'h2h') {
    pHome = state.probability;
  } else if (market.kind === 'spread') {
    const favIsHome = market.meta.favouriteSlug === market.meta.homeSlug;
    const fav = favIsHome ? state.home : state.away;
    const dog = favIsHome ? state.away : state.home;
    const pCover = liveSpreadProbability(fav, dog, market.meta.spread);
    return {
      cover: priceWithMargin(pCover, margin),
      nocover: priceWithMargin(1 - pCover, margin),
      probability: pCover,
    };
  } else {
    return null;
  }

  return {
    home: priceWithMargin(pHome, margin),
    away: priceWithMargin(1 - pHome, margin),
    probability: pHome,
  };
}

function priceWithMargin(p, margin) {
  // Split the margin across both sides, and never quote past 97% -- beyond
  // that the price is meaningless and the market should have closed.
  return probabilityToOdds(Math.min(0.97, p + margin / 2));
}
