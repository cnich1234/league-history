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
export const TARGET = {
  BET: 'bet',
  MARKET: 'market',
  BETTOR: 'bettor',
  OWN_BET: 'own_bet',
  // A bet of yours that has already settled as a win.
  WON_BET: 'won_bet',
  // The whole week, rather than one bet.
  WEEK: 'week',
  // No target at all: it arms, and the next bet placed consumes it.
  NEXT_BET: 'next_bet',
};

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
    target: TARGET.WON_BET,
    blurb: 'Adds 50% to a bet that has already won.',
    detail:
      'Used after the week settles, on any winner from that week -- so you can put it ' +
      'on your biggest one. No risk, which is why it costs more than the odds boost.',
    multiplier: 1.5,
    settledOnly: true,
  },
  {
    kind: 'boost-week',
    name: 'Big Week',
    icon: '🎰',
    cost: 20,
    family: FAMILY.PAYOUT,
    target: TARGET.WEEK,
    blurb: 'Adds 50% to EVERY bet you win this week.',
    detail:
      'Declared before the games and applied to every winner. Five winners all pay half ' +
      'again -- and if nothing wins, it is gone. A bet on your own week.',
    multiplier: 1.5,
  },
  {
    kind: 'odds-boost',
    name: 'Better Price',
    icon: '⚡',
    cost: 5,
    family: FAMILY.PRICE,
    target: TARGET.NEXT_BET,
    blurb: 'Improves the odds on your next bet by 50%.',
    detail:
      'Boosts the profit, not the payout: +200 becomes +300, so $100 wins $300 instead ' +
      'of $200. Applied when you place, and the price is locked in from then on.',
    oddsMultiplier: 1.5,
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

  // ---------- coming soon ----------
  //
  // These all need to know WHICH bet they are hitting, and bets are hidden
  // until their market locks. Listing someone's bet in a picker would leak
  // their position, which is the one rule the whole book rests on. They are
  // shown here so the league can see what is coming and argue about it, but
  // they cannot be bought until that question is settled.
  {
    kind: 'steal',
    name: 'Grand Theft',
    icon: '🥷',
    cost: 14,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: "Takes someone else's bet for yourself, before anyone knows if it wins.",
    detail:
      'Used while the bet is still pending, so you are gambling on their judgement ' +
      'rather than collecting a sure thing. Steal a loser and the points are gone. ' +
      'Blocked by Insurance.',
    // Cheaper than The Void because it is a gamble, not a certainty. Price
    // tracks how sure the outcome is, not how much damage it does: steal a
    // loser and the points bought nothing at all.
    steals: true,
    blind: true,
    attack: true,
    comingSoon: true,
  },
  {
    kind: 'blind-sabotage',
    name: 'Blind Sabotage',
    icon: '🎯',
    cost: 10,
    family: FAMILY.PAYOUT,
    target: TARGET.BETTOR,
    blurb: 'Hits a manager, not a bet. Their next bet this week gets worse.',
    detail:
      'You pick the person and never learn what you hit -- which is the point. ' +
      'Nothing about their position is revealed to you.',
    attack: true,
    comingSoon: true,
  },
  {
    kind: 'void',
    name: 'The Void',
    icon: '🕳️',
    cost: 22,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: 'Sends one winning bet into the void. It pays nothing.',
    detail:
      'Not a cut -- the whole thing. Used after the games, once bets are public, ' +
      'so it reveals nothing: by then nobody can act on what they see. Their stake ' +
      'is gone with it. Blocked by Insurance.',
    // Total negation, not a percentage. The payout goes to zero rather than
    // being scaled, so this cannot be expressed as a multiplier like Skim.
    //
    // The dearest attack in the shop, because it is the only certain one: you
    // are looking at a bet that has already won when you kill it. Nobody
    // gains, which is the point -- this buys spite, not money.
    negates: true,
    settledOnly: true,
    attack: true,
    comingSoon: true,
  },
];

export const byKind = Object.fromEntries(BOOSTS.map((b) => [b.kind, b]));

/** Boosts that change a payout, in the order they are applied. */
export const PAYOUT_ORDER = ['boost-50', 'boost-week', 'payout-cut', 'void'];

/**
 * Improves a price by boosting the PROFIT, not the payout.
 *
 * +200 becomes +300: a $100 bet wins $300 instead of $200. Worth being explicit
 * that this is weaker than a payout boost of the same size, because the stake
 * comes back either way and only the profit is multiplied. At -300 the gap is
 * stark -- $375 against $500 on a $250 bet.
 *
 * Done in decimal space for the same reason parlay odds are: American odds do
 * not multiply, and 1.5x on -110 is not -73.
 */
export function boostOdds(odds, multiplier = 1.5) {
  const decimal = odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
  const boosted = 1 + (decimal - 1) * multiplier;
  return boosted >= 2
    ? Math.round((boosted - 1) * 100)
    : -Math.round(100 / (boosted - 1));
}

/**
 * Final payout for a bet, after every boost attached to it.
 *
 * Order is fixed and documented because it changes the answer: a 50% boost then
 * a 20% cut is not the same as a cut then a boost. Multiply up first, then take
 * the cut off the result -- so the cut always bites the number the winner
 * actually expected to see.
 *
 * Half Again and Big Week both multiply by 1.5, and holding both on one bet
 * would compound to 2.25x. They stack deliberately -- Big Week is declared
 * blind before the games and Half Again is placed on a known winner, so someone
 * who did both earned it.
 *
 * `basePayout` is the ordinary payout in cents, stake included. Returns cents.
 */
export function applyBoosts(basePayout, kinds = []) {
  const held = new Set(kinds);
  // Insurance blocks every attack. It is not a modifier of its own.
  const shielded = held.has('insurance');

  // A negation is absolute: nothing that multiplies afterwards can bring a
  // voided bet back, so it short-circuits rather than joining the chain. A
  // shield still blocks it, same as any other attack.
  for (const kind of PAYOUT_ORDER) {
    const def = byKind[kind];
    if (def?.negates && held.has(kind) && !shielded) return 0;
  }

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
