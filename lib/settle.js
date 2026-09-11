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

    // A blowout market asks "does EITHER team win by more than the line", with
    // one option per manager. Unlike an ordinary spread it has three outcomes,
    // not two: the third is a close game, in which both sides lose. That is why
    // both can be priced at plus money -- "neither" is the likeliest result.
    //
    // The option key is a roster id, so settling is just "whose blowout was it".
    if (meta.blowout) {
      const margin = home - away;
      if (margin > meta.spread) return String(meta.homeRoster);
      if (-margin > meta.spread) return String(meta.awayRoster);
      // Nobody covered. Not a push -- a losing outcome for every bet on it,
      // which is the whole reason the prices are long.
      return 'nobody';
    }

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
    const pid = String(meta.playerId);

    // Props are written for the whole roster, so "benched" is not a reason to
    // void -- for a bench prop it is the premise of the bet. What matters is
    // whether the player was AVAILABLE to score.
    //
    // A prop written on a starter that is later benched is still voided: the
    // line was set for a starter's workload and the bet nobody could win is
    // not one they should lose.
    if (meta.benched !== true && !startedPlayers.has(pid)) return 'void';

    // No entry at all means inactive or on a bye -- never had a chance either
    // way. A real zero comes back as 0, not undefined.
    const scored = pointsByPlayer[pid];
    if (scored == null) return 'void';
    return scored > meta.line ? 'over' : 'under';
  }

  if (market.kind === 'showdown') {
    return resolveShowdown(market, { starterRosters, positionOf });
  }

  if (market.kind === 'special') {
    return resolveSpecial(market, { pointsByRoster, starterRosters, positionOf });
  }

  return null;
}

/**
 * Positional showdown: one manager's starters at a position against the
 * other's, with a handicap.
 *
 * Only STARTERS count, same as everywhere else -- a WR on the bench scored his
 * manager nothing and does not belong in the comparison. The handicap is
 * applied to the underdog exactly as a spread is, and lines are half-points so
 * a push is impossible by construction.
 *
 * Voids rather than guesses if either side started nobody at the position: a
 * lineup with no TE cannot lose a TE showdown, because there was never a bet
 * to win.
 */
function resolveShowdown(market, { starterRosters, positionOf }) {
  const meta = market.meta ?? {};
  const { position, homeRoster, awayRoster, spread = 0, favouriteSide } = meta;
  if (!position || !starterRosters || !positionOf) return 'void';

  const totals = { [homeRoster]: null, [awayRoster]: null };
  for (const [playerId, entry] of Object.entries(starterRosters)) {
    if (positionOf(playerId) !== position) continue;
    if (!(entry.rosterId in totals)) continue;
    totals[entry.rosterId] = (totals[entry.rosterId] ?? 0) + entry.points;
  }

  const home = totals[homeRoster];
  const away = totals[awayRoster];
  // null means nobody was started there, which is different from scoring zero.
  if (home == null || away == null) return 'void';

  const favIsHome = favouriteSide === 'home';
  const favourite = favIsHome ? home : away;
  const underdog = favIsHome ? away : home;
  return favourite - underdog > spread ? 'cover' : 'nocover';
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
