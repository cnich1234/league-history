/**
 * When one pick guarantees another.
 *
 * Chris built a three-leg parlay on Devin +4.5, Devin by 20.5+ and Devin by
 * 30.5+, and it priced at +3278. But "wins by more than 30.5" already contains
 * "wins by more than 20.5", which already contains "does not lose by 4.5" -- so
 * all three win exactly when the hardest one does. The honest price was +397.
 * The slip was paying 8.26x for it.
 *
 * A parlay multiplies odds because its legs are assumed to be separate
 * questions. When one leg's answer settles another's, that assumption is false
 * and the multiplication is free money. This module names those pairs so the
 * book can refuse them.
 *
 * The test is deliberately one-directional: `implies(a, b)` asks whether every
 * world where A wins is a world where B wins. If so, adding B to a slip that
 * already holds A changes nothing about when the parlay pays -- it only
 * inflates the price.
 *
 * All of this reasons about MARGIN, the only quantity these markets share:
 *
 *   spread (standard)   home -L    home margin > L
 *                       away +L    home margin < L   (away covers)
 *   spread (blowout)    X by L+    X's margin > L
 *   h2h                 X wins     X's margin > 0
 *
 * A total or a prop is about points scored, not margin, so it shares no
 * ground with these and is never implied by them. Two props on the SAME
 * player are the one other family that nests, and they are handled too.
 */

/**
 * One pick reduced to a claim, or null when it makes no claim we can compare.
 *
 * `{ kind: 'margin', team, gt }`  team's margin of victory is greater than gt
 *                                 (gt may be negative: "loses by less than 4.5"
 *                                 is margin > -4.5)
 * `{ kind: 'points', player, over, line }` a player's own points
 */
export function claimOf(market, optionKey) {
  const meta = market?.meta ?? {};
  const kind = market?.kind;

  if (kind === 'h2h') {
    // option_key is 'home' or 'away', NOT a roster id -- so it has to be
    // resolved against the market's own rosters. Treating the key as the team
    // put every matchup's home side in one bucket and reported nonsense.
    const home = meta.homeRoster == null ? null : String(meta.homeRoster);
    const away = meta.awayRoster == null ? null : String(meta.awayRoster);
    if (!home || !away) return null;
    if (optionKey === 'home') return { kind: 'margin', team: home, gt: 0 };
    if (optionKey === 'away') return { kind: 'margin', team: away, gt: 0 };
    return null;
  }

  if (kind === 'spread') {
    const line = Number(meta.spread);
    if (!Number.isFinite(line)) return null;

    // "Either team by L+": the option key is the roster id winning big.
    if (meta.blowout) return { kind: 'margin', team: String(optionKey), gt: line };

    // Standard: the favourite covers, or the underdog does. Which roster is
    // the favourite comes from favouriteSlug against homeSlug -- a standard
    // spread carries slugs, while a showdown carries favouriteSide.
    const home = meta.homeRoster == null ? null : String(meta.homeRoster);
    const away = meta.awayRoster == null ? null : String(meta.awayRoster);
    if (!home || !away) return null;
    const favIsHome =
      meta.favouriteSlug != null
        ? meta.favouriteSlug === meta.homeSlug
        : meta.favouriteSide !== 'away';
    const fav = favIsHome ? home : away;
    const dog = favIsHome ? away : home;
    // cover = favourite's margin > line; nocover = the dog's margin > -line,
    // which is the same statement read from the other side.
    if (optionKey === 'cover') return { kind: 'margin', team: fav, gt: line };
    if (optionKey === 'nocover') return { kind: 'margin', team: dog, gt: -line };
    return null;
  }

  if (kind === 'prop') {
    const line = Number(meta.line);
    const player = meta.playerId == null ? null : String(meta.playerId);
    if (!player || !Number.isFinite(line)) return null;
    if (optionKey === 'over') return { kind: 'points', player, over: true, line };
    if (optionKey === 'under') return { kind: 'points', player, over: false, line };
    return null;
  }

  // Showdowns compare position groups, totals compare one roster's score.
  // Neither nests with a margin claim, and two of them only nest with each
  // other in ways the board does not currently produce (one line per pair).
  return null;
}

/**
 * Does winning A guarantee winning B?
 *
 * Same team, both margin claims: a higher bar implies every lower one.
 * "Wins by more than 30.5" implies "wins by more than 20.5" implies "wins"
 * implies "does not lose by more than 4.5".
 */
export function implies(a, b) {
  if (!a || !b) return false;

  if (a.kind === 'margin' && b.kind === 'margin') {
    if (a.team !== b.team) return false;
    // margin > a.gt guarantees margin > b.gt exactly when a.gt >= b.gt.
    return a.gt >= b.gt;
  }

  if (a.kind === 'points' && b.kind === 'points') {
    if (a.player !== b.player) return false;
    // over 26 implies over 16; under 7 implies under 12.
    if (a.over && b.over) return a.line >= b.line;
    if (!a.over && !b.over) return a.line <= b.line;
    return false;
  }

  return false;
}

/**
 * The redundant legs in a slip, each paired with the leg that already contains
 * it. Returns [] when every leg is a genuinely separate question.
 *
 * `legs` is [{ marketId, optionKey, market }] where `market` carries kind and
 * meta. The leg KEPT is the one that survives: the strictest of a nested set,
 * since it is the one that actually has to happen.
 */
export function redundantLegs(legs) {
  const claims = legs.map((l) => ({ ...l, claim: claimOf(l.market, l.optionKey) }));
  const out = [];
  for (const b of claims) {
    if (!b.claim) continue;
    for (const a of claims) {
      if (a === b || !a.claim) continue;
      // A implies B, and they are not the identical claim twice over (which
      // the one-leg-per-market rule already stops).
      if (implies(a.claim, b.claim) && !implies(b.claim, a.claim)) {
        out.push({ redundant: b, impliedBy: a });
        break;
      }
    }
  }
  return out;
}
