/**
 * Data access for the league history app.
 *
 * league.json is generated at build time by scripts/build-stats.mjs and imported
 * directly, so every page is prerendered as static HTML — no runtime fetching,
 * no server, no ESPN dependency once deployed.
 */

import league from '@/data/league.json';

export function getLeague() {
  return league;
}

export function getOwners() {
  return league.owners;
}

export function getOwner(slug) {
  return league.owners.find((owner) => owner.slug === slug) ?? null;
}

export function getSeasons() {
  return league.seasons;
}

/** Seasons with at least one game played — the ones that count toward records. */
export function getPlayedSeasons() {
  return league.seasons.filter((season) => season.played);
}

/**
 * Head-to-head records for one owner against everyone they have faced,
 * sorted by most games played.
 */
export function getHeadToHead(slug) {
  const rows = league.headToHead.filter((row) => row.a === slug && row.games > 0);
  const byName = new Map(league.owners.map((owner) => [owner.slug, owner.name]));

  return rows
    .map((row) => ({ ...row, opponentName: byName.get(row.b) ?? row.b }))
    .sort((x, y) => y.games - x.games || y.winPct - x.winPct);
}

/** Every game an owner played, newest first. */
export function getGames(slug) {
  return league.games
    .filter((game) => game.home === slug || game.away === slug)
    .map((game) => {
      const isHome = game.home === slug;
      const points = isHome ? game.homePoints : game.awayPoints;
      const opponentPoints = isHome ? game.awayPoints : game.homePoints;
      return {
        season: game.season,
        week: game.week,
        isPlayoff: game.isPlayoff,
        opponent: isHome ? game.away : game.home,
        points,
        opponentPoints,
        won: points > opponentPoints,
        tied: points === opponentPoints,
        margin: Math.round((points - opponentPoints) * 10) / 10,
      };
    })
    .sort((a, b) => b.season - a.season || b.week - a.week);
}

/** Rank owners by a numeric field, descending unless `ascending` is set. */
export function leaderboard(field, { ascending = false, minGames = 0, limit = null } = {}) {
  const rows = league.owners
    .filter((owner) => owner.games >= minGames && owner[field] != null)
    .sort((a, b) => (ascending ? a[field] - b[field] : b[field] - a[field]));
  return limit ? rows.slice(0, limit) : rows;
}

/** The single highest- and lowest-scoring games in league history. */
export function getScoringExtremes() {
  const byName = new Map(league.owners.map((owner) => [owner.slug, owner.name]));

  let highest = null;
  let lowest = null;

  for (const game of league.games) {
    for (const [slug, points, oppSlug] of [
      [game.home, game.homePoints, game.away],
      [game.away, game.awayPoints, game.home],
    ]) {
      if (!slug || points == null) continue;
      const entry = {
        slug,
        name: byName.get(slug) ?? slug,
        points,
        season: game.season,
        week: game.week,
        opponentName: byName.get(oppSlug) ?? oppSlug,
      };
      if (!highest || points > highest.points) highest = entry;
      // Guard against 0-point placeholder rows.
      if (points > 0 && (!lowest || points < lowest.points)) lowest = entry;
    }
  }

  return { highest, lowest };
}

/** Biggest blowout and closest finish across all games. */
export function getMarginExtremes() {
  const byName = new Map(league.owners.map((owner) => [owner.slug, owner.name]));
  let blowout = null;
  let nailbiter = null;

  for (const game of league.games) {
    if (!game.home || !game.away) continue;
    if (!(game.homePoints > 0) || !(game.awayPoints > 0)) continue;

    const margin = Math.abs(game.homePoints - game.awayPoints);
    const homeWon = game.homePoints > game.awayPoints;
    const entry = {
      margin: Math.round(margin * 10) / 10,
      winnerName: byName.get(homeWon ? game.home : game.away),
      loserName: byName.get(homeWon ? game.away : game.home),
      winnerPoints: homeWon ? game.homePoints : game.awayPoints,
      loserPoints: homeWon ? game.awayPoints : game.homePoints,
      season: game.season,
      week: game.week,
    };

    if (!blowout || margin > blowout.margin) blowout = entry;
    if (margin > 0 && (!nailbiter || margin < nailbiter.margin)) nailbiter = entry;
  }

  return { blowout, nailbiter };
}
