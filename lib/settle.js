/**
 * Decides the winning option for a settled market.
 *
 * Kept separate from the CLI so it can be tested against known scores without
 * calling Sleeper. Returns an option key, 'push' for a genuine tie, 'void' when
 * the market cannot be decided fairly, or null for an unknown kind.
 */
export function resolveMarket(market, { pointsByRoster, pointsByPlayer, startedPlayers }) {
  const meta = market.meta ?? {};

  if (market.kind === 'h2h') {
    const home = pointsByRoster[meta.homeRoster];
    const away = pointsByRoster[meta.awayRoster];
    if (home == null || away == null) return 'void';
    // Fantasy ties are vanishingly rare but do happen; refund rather than
    // arbitrarily picking a side.
    if (home === away) return 'push';
    return home > away ? 'home' : 'away';
  }

  if (market.kind === 'spread') {
    const home = pointsByRoster[meta.homeRoster];
    const away = pointsByRoster[meta.awayRoster];
    if (home == null || away == null) return 'void';
    // The favourite may be either side of the matchup; work out its margin.
    const favIsHome = meta.favouriteSlug === meta.homeSlug;
    const margin = favIsHome ? home - away : away - home;
    // Lines are half-points, so a push is impossible by construction.
    return margin > meta.spread ? 'cover' : 'nocover';
  }

  if (market.kind === 'total') {
    const scored = pointsByRoster[meta.rosterId];
    if (scored == null) return 'void';
    return scored > meta.line ? 'over' : 'under';
  }

  if (market.kind === 'prop') {
    // A player who was benched or inactive never had a chance to hit the line.
    // Settling that as "under" would punish a bet nobody could have won.
    if (!startedPlayers.has(String(meta.playerId))) return 'void';
    const scored = pointsByPlayer[String(meta.playerId)];
    if (scored == null) return 'void';
    return scored > meta.line ? 'over' : 'under';
  }

  return null;
}
