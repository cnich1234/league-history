/**
 * Decides the winning option for a settled market.
 *
 * Kept separate from the CLI so it can be tested against known scores without
 * calling Sleeper. Returns an option key, 'push' for a genuine tie, 'void' when
 * the market cannot be decided fairly, or null for an unknown kind.
 */
export function resolveMarket(
  market,
  { pointsByRoster, pointsByPlayer, startedPlayers, starterRosters, positionOf },
) {
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

  if (market.kind === 'special') {
    return resolveSpecial(market, { pointsByRoster, starterRosters, positionOf });
  }

  return null;
}

/**
 * League-wide "who had the best X this week" markets.
 *
 * These are unlike every other kind: one market for the whole league with ten
 * options rather than two, and no matchup behind them. The option key is a
 * roster id, so settling is just "whose roster owns the winner".
 *
 * Ties push. Two managers can genuinely share a high score, and picking one
 * arbitrarily would take real money off someone who was not wrong.
 */
function resolveSpecial(market, { pointsByRoster, starterRosters, positionOf }) {
  const meta = market.meta ?? {};

  if (meta.special === 'team') {
    const entries = Object.entries(pointsByRoster);
    if (!entries.length) return 'void';
    const best = Math.max(...entries.map(([, pts]) => pts));
    const winners = entries.filter(([, pts]) => pts === best);
    if (winners.length > 1) return 'push';
    return String(winners[0][0]);
  }

  // Positional: the highest-scoring STARTER at that position, anywhere in the
  // league. A player on a bench did not count for his manager's score and does
  // not count here either.
  const position = meta.position;
  if (!position || !starterRosters || !positionOf) return 'void';

  let best = null;
  const winners = [];
  for (const [playerId, entry] of Object.entries(starterRosters)) {
    if (positionOf(playerId) !== position) continue;
    const pts = entry.points;
    if (pts == null) continue;
    if (best == null || pts > best) {
      best = pts;
      winners.length = 0;
      winners.push(entry.rosterId);
    } else if (pts === best && !winners.includes(entry.rosterId)) {
      winners.push(entry.rosterId);
    }
  }

  if (best == null) return 'void';
  if (winners.length > 1) return 'push';
  return String(winners[0]);
}
