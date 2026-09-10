/**
 * The shop: what you can buy with trophy points, and what it does.
 *
 * One definition per boost, read by the store, the bet slip and settlement, so
 * a price or a rule exists in exactly one place. Everything here is data --
 * nothing touches the database, so it can be tested without one.
 *
 * Two families, and the difference matters for when they can be used:
 *
 *   - PAYOUT boosts change what a settled bet pays. They attach to a bet and
 *     are applied at settlement.
 *   - PRICE boosts change what a bet costs to place. They attach to a market
 *     and are applied at placement.
 *
 * A payout boost can safely be used after a market locks, because the money has
 * not moved yet. A price boost cannot -- once bets are placed at a price,
 * changing it retroactively would rewrite history.
 */

export const FAMILY = { PAYOUT: 'payout', PRICE: 'price', ACTION: 'action' };

/** What a boost points at. Decides which target_* column it uses. */
export const TARGET = { BET: 'bet', MARKET: 'market', BETTOR: 'bettor', OWN_BET: 'own_bet' };

/**
 * Weekly allowance, credited to every manager.
 *
 * Enough to buy a cheap boost most weeks, or save two weeks for something that
 * bites. Trophies are what pay for the expensive end.
 */
export const WEEKLY_ALLOWANCE = 5;

/**
 * Prices are spread deliberately.
 *
 * The allowance alone buys the cheap tier every week or two. Everything that
 * bites someone else needs trophies on top, which is the whole point of tying
 * the shop to the Trophy Room: a manager who never wins anything on the field
 * can still defend and boost themselves, but cannot go on the offensive.
 *
 * A first pass was 4-8 across the board, which made the dearest boost 1.6 weeks
 * of allowance -- trophies were decoration. These need re-tuning once a real
 * week of scoring shows what a typical trophy haul actually is.
 */

export const BOOSTS = [
  // ---------- defence ----------
  {
    kind: 'insurance',
    name: 'Insurance',
    icon: '🛡️',
    cost: 4,
    family: FAMILY.PAYOUT,
    target: TARGET.OWN_BET,
    blurb: 'Shields one of your bets from every attack.',
    detail:
      'Attach it before anyone hits you -- it cannot be added after the fact. ' +
      'A shielded bet ignores payout cuts and cannot be stolen.',
    // Defensive: it has no effect of its own, it only blocks others.
    defensive: true,
  },

  // ---------- your own upside ----------
  {
    kind: 'boost-50',
    name: 'Half Again',
    icon: '📈',
    cost: 8,
    family: FAMILY.PAYOUT,
    target: TARGET.OWN_BET,
    blurb: 'Adds 50% to a winning bet. $100 returns $150.',
    detail:
      'Applied to the whole payout, stake included. Does nothing if the bet loses, ' +
      'so it is a bet on your own bet.',
    multiplier: 1.5,
  },
  {
    kind: 'cash-out',
    name: 'Cash Out',
    icon: '💸',
    cost: 6,
    family: FAMILY.ACTION,
    target: TARGET.OWN_BET,
    blurb: 'Settle a live bet early at the current price.',
    detail:
      'Live markets only, while the games are running -- a prop or a position battle ' +
      'has no live price to settle against. Take the money and stop watching.',
    liveOnly: true,
  },

  // ---------- attack ----------
  {
    kind: 'payout-cut',
    name: 'Skim',
    icon: '✂️',
    cost: 14,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: "Cuts 20% off someone else's payout if their bet wins.",
    detail:
      'Costs them nothing if they lose, which is the joke. Blocked by Insurance.',
    payoutCut: 0.2,
    attack: true,
  },
  {
    kind: 'market-poison',
    name: 'Poison the Well',
    icon: '☠️',
    cost: 12,
    family: FAMILY.PRICE,
    target: TARGET.MARKET,
    blurb: 'Worsens the price on one market for everyone, including you.',
    detail:
      'Public on the board -- people can see a market has been poisoned and go ' +
      'elsewhere. Using it tells the league what you care about.',
    marginBump: 0.09,
    attack: true,
  },
];

export const byKind = Object.fromEntries(BOOSTS.map((b) => [b.kind, b]));

/** Boosts that change a payout, in the order they are applied. */
export const PAYOUT_ORDER = ['boost-50', 'payout-cut'];

/**
 * Final payout for a bet, after every boost attached to it.
 *
 * Order is fixed and documented because it changes the answer: a 50% boost then
 * a 20% cut is not the same as a cut then a boost. Multiply up first, then take
 * the cut off the result -- so the cut always bites the number the winner
 * actually expected to see.
 *
 * `basePayout` is the ordinary payout in cents, stake included. Returns cents.
 */
export function applyBoosts(basePayout, kinds = []) {
  const held = new Set(kinds);
  // Insurance blocks every attack. It is not a modifier of its own.
  const shielded = held.has('insurance');

  let payout = basePayout;
  for (const kind of PAYOUT_ORDER) {
    if (!held.has(kind)) continue;
    const def = byKind[kind];
    if (!def) continue;
    if (def.attack && shielded) continue;

    if (def.multiplier) payout *= def.multiplier;
    if (def.payoutCut) payout *= 1 - def.payoutCut;
  }
  return Math.round(payout);
}

/** Whether a boost may still be attached to a bet in this state. */
export function canAttach(def, { marketLocked, marketLive, betStatus }) {
  if (!def) return { ok: false, why: 'No such boost.' };
  if (betStatus && betStatus !== 'pending') {
    return { ok: false, why: 'That bet has already settled.' };
  }

  // A price boost rewrites what a bet costs, so it cannot land after bets exist
  // at the old number.
  if (def.family === FAMILY.PRICE && marketLocked) {
    return { ok: false, why: 'That market has closed -- prices are fixed.' };
  }

  // Cash out needs a live price to settle against.
  if (def.liveOnly && !marketLive) {
    return { ok: false, why: 'Only live markets can be cashed out.' };
  }
  if (def.liveOnly && !marketLocked) {
    return { ok: false, why: 'Nothing to cash out until the games start.' };
  }

  return { ok: true };
}
