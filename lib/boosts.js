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
 * Set against what the trophies actually pay. The points simulation
 * (scripts/sim-points.mjs) puts a season's trophy haul at about 99 points over
 * 14 weeks, so 7 a week is the number that splits a manager's income evenly
 * between showing up and winning things -- the 50/50 the league asked for.
 *
 * It also keeps the floor honest: somebody who never wins a trophy still
 * collects 98 across a season, which is two Skims and change. At 5 it was three
 * weeks of saving for anything that bites.
 */
export const WEEKLY_ALLOWANCE = 7;

/**
 * Prices are spread deliberately.
 *
 * The allowance alone buys the cheap tier every week or two. Everything that
 * bites someone else needs trophies on top, which is the whole point of tying
 * the shop to the Trophy Room: a manager who never wins anything on the field
 * can still defend and boost themselves, but cannot go on the offensive.
 *
 * Priced against the simulation rather than by feel. A season's income is about
 * 197 points (99 trophy + 7/wk allowance over 14 weeks) and one of every boost
 * in the shop costs 588 -- three seasons. So a year buys roughly a third of the
 * catalogue and the choices actually bind.
 *
 * They did not, before. The first pass was 4-8 across the board, set when the
 * simulation said 27 trophy points a season; it later said 99, which left a
 * season able to buy one of literally everything with points to spare. Every
 * price was multiplied by 3 to fix that, which kept the ordering that had been
 * argued over and changed only the scale.
 */

export const BOOSTS = [
  // ---------- defence ----------
  {
    kind: 'insurance',
    name: 'Insurance',
    icon: '🛡️',
    cost: 36,
    family: FAMILY.PAYOUT,
    target: TARGET.OWN_BET,
    blurb: 'Shields one of your bets from every attack.',
    detail:
      'Attach it before anyone hits you -- it cannot be added after the fact. A ' +
      'shielded bet ignores payout cuts and cannot be stolen. Priced to be a ' +
      'choice rather than a habit: it costs more than almost everything it ' +
      'blocks, so it goes on the bet you would hate to lose, not on all of them.',
    // Defensive: it has no effect of its own, it only blocks others.
    defensive: true,
  },

  {
    kind: 'mirror',
    name: 'Mirror',
    icon: '🪞',
    cost: 30,
    family: FAMILY.PAYOUT,
    target: TARGET.OWN_BET,
    blurb: 'An attack on this bet rebounds onto the attacker instead.',
    detail:
      'Where Insurance absorbs a hit, this returns it -- whoever fires at a mirrored bet ' +
      'takes the same attack on their own biggest open bet. They are told. Place it ' +
      'before anyone aims at you; it cannot be added afterwards.',
    defensive: true,
    reflects: true,
  },
  {
    kind: 'ghost',
    name: 'Ghost',
    icon: '👻',
    cost: 15,
    family: FAMILY.ACTION,
    target: TARGET.WEEK,
    blurb: 'Your bets vanish from The Action for a week.',
    detail:
      'Nobody can attack what they cannot see. The cheapest protection in the shop ' +
      'because it hides everything rather than shielding one bet -- but it is a whole ' +
      'week, declared in advance, and anyone paying attention will notice you have gone ' +
      'quiet.',
    defensive: true,
    hides: true,
  },
  {
    kind: 'receipt',
    name: 'Receipt',
    icon: '🧾',
    cost: 3,
    family: FAMILY.ACTION,
    target: TARGET.OWN_BET,
    blurb: 'Find out who attacked one of your bets.',
    detail:
      'Attacks are anonymous by default. This names the person -- it changes no money at ' +
      'all, it just turns a hit into a grudge. A penny, because knowing is its own reward.',
    reveals: true,
  },

  // ---------- your own upside ----------
  {
    kind: 'boost-50',
    name: 'Half Again',
    icon: '📈',
    cost: 24,
    family: FAMILY.PAYOUT,
    target: TARGET.OWN_BET,
    blurb: 'Adds 50% to one of your bets, if it wins.',
    detail:
      'Declared on a bet that is still live, like everything else -- pick wrong and it ' +
      'pays for nothing. It used to be usable on a bet that had already won, which made ' +
      'it the one boost in the shop with no risk at all; now you have to call it.',
    multiplier: 1.5,
  },
  {
    kind: 'boost-week',
    name: 'Big Week',
    icon: '🎰',
    cost: 60,
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
    cost: 15,
    family: FAMILY.PRICE,
    target: TARGET.NEXT_BET,
    blurb: 'Improves the odds on one bet by 50%.',
    detail:
      'Offered as a tick-box when you place a bet, with the new price shown before you ' +
      'commit. Boosts the profit, not the payout: +200 becomes +300, so $100 wins $300 ' +
      'rather than $200.',
    oddsMultiplier: 1.5,
  },
  {
    kind: 'hedge',
    name: 'Hedge',
    icon: '🎣',
    cost: 24,
    family: FAMILY.ACTION,
    target: TARGET.OWN_BET,
    blurb: 'Back the other side of a bet you already have.',
    detail:
      'Normally one bet per market. This lets you take the opposite side at the current ' +
      'price, which on a live market is a very different number from the one you got -- ' +
      'so a position gone wrong can be squared off rather than ridden out. Both bets ' +
      'settle on their own merits.',
    hedges: true,
  },
  {
    kind: 'lock-in',
    name: 'Lock In',
    icon: '📌',
    cost: 21,
    family: FAMILY.PRICE,
    target: TARGET.MARKET,
    blurb: 'Freezes a live price for you for 30 minutes.',
    detail:
      'The number stops moving while you decide -- for you only; everyone else still bets ' +
      'the live market. No real sportsbook offers this. Claim it by betting that market ' +
      'before the half hour is up, or it expires unused.',
    locksPrice: true,
    lockMinutes: 30,
  },
  {
    kind: 'undo',
    name: 'Undo',
    icon: '⏮️',
    cost: 75,
    family: FAMILY.ACTION,
    target: TARGET.OWN_BET,
    blurb: 'Void one of your own bets and take the whole stake back.',
    detail:
      'Works on any bet that has not settled, live ones included -- watch it dying and ' +
      'pull out. The dearest thing in the shop because it removes the risk entirely. ' +
      'Cash Out is the everyday version: cheaper, but it settles at the current price ' +
      'rather than handing the stake back.',
    voids: true,
  },
  {
    kind: 'cash-out',
    name: 'Cash Out',
    icon: '💸',
    cost: 18,
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
    cost: 24,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: "Cuts 20% off someone else's payout if their bet wins.",
    detail:
      'Costs them nothing if they lose, which is the joke. Blocked by Insurance.',
    payoutCut: 0.2,
    attack: true,
  },
  {
    kind: 'slow-play',
    name: 'Slow Play',
    icon: '🐌',
    cost: 15,
    family: FAMILY.ACTION,
    target: TARGET.BETTOR,
    blurb: 'Their next REAL bet this week costs double the stake.',
    detail:
      'Hits the allowance rather than the payout -- the only attack that does. A $500 ' +
      'week buys half as much until they have worn it off, and they find out when they ' +
      'go to bet. Only a bet of $50 or more wears it off: without that floor a $1 punt ' +
      'discharges it for a cent, and anyone who knows the boost exists would open every ' +
      'week with one. Still cheap, because it costs them nothing if they stop betting.',
    doublesStake: true,
    // A bet under this does NOT clear the slow -- and is not doubled either.
    // Both halves matter: charging a $1 bet $2 without burning the boost would
    // be a tax on nothing.
    minStakeDollars: 50,
    attack: true,
  },
  {
    kind: 'switcheroo',
    name: 'Switcheroo',
    icon: '🔀',
    cost: 42,
    family: FAMILY.ACTION,
    target: TARGET.BET,
    blurb: 'Moves one of their bets to a different option.',
    detail:
      'Completely blind: you have no idea what you are moving, and it is as likely to ' +
      'rescue a dead bet as it is to kill a winner. On a two-sided market it flips to ' +
      'the other side. On a ten-way special it lands somewhere random -- which is far ' +
      'worse for them. On a parlay it picks one live leg at random and moves that, so a ' +
      'long slip is not the safe place to hide. Blocked by Insurance.',
    flips: true,
    attack: true,
  },
  {
    kind: 'market-poison',
    name: 'Poison the Well',
    icon: '☠️',
    cost: 36,
    family: FAMILY.PRICE,
    target: TARGET.MARKET,
    blurb: 'Worsens the price on one market for everyone, including you.',
    detail:
      'Public on the board -- people can see a market has been poisoned and go ' +
      'elsewhere. Using it tells the league what you care about.',
    marginBump: 0.09,
    attack: true,
  },

  {
    kind: 'ride-along',
    name: 'Ride Along',
    icon: '🚗',
    cost: 21,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: "Copies someone else's bet at your own stake. You will not know what it is.",
    detail:
      'You see the price and the size on the Action board, never the pick -- so this is ' +
      'a bet on the person, not the wager. Costs you the stake out of this week, same as ' +
      'betting it yourself. Cannot be attacked or insured: it is a new bet of your own.',
    // Not an attack. It takes nothing from the person copied -- they keep their
    // bet exactly as it was, and both win or lose together.
    copies: true,
  },

  // ---------- blind attacks ----------
  //
  // These target a bet on the attack board, where you can see WHO bet, HOW
  // MUCH, at what odds and what it would return -- but never which market or
  // which side. Enough to judge whether a bet is worth hitting; nothing you
  // could copy.
  //
  // That is why they are cheap. A $250 bet at +600 is obviously the juicy
  // target, but you have no idea whether it is going to land. Hitting a loser
  // costs you the points and does nothing.
  {
    kind: 'steal',
    name: 'Grand Theft',
    icon: '🥷',
    cost: 27,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: "Takes someone else's bet for yourself. They lose everything.",
    detail:
      'The whole payout, stake included -- they get nothing back. You are gambling ' +
      'on their judgement, though: steal a loser and the points bought you nothing. ' +
      'Blocked by Insurance.',
    // Cheaper than The Void because it is a gamble, not a certainty. Price
    // tracks how sure the outcome is, not how much damage it does: steal a
    // loser and the points bought nothing at all.
    steals: true,
    blind: true,
    attack: true,
  },
  {
    kind: 'tithe',
    name: 'Cut of the Action',
    icon: '🤝',
    cost: 15,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: 'Half their winnings, if it wins. They keep the bet and the rest.',
    detail:
      'The gentle end of the shop. Grand Theft takes everything and leaves them with ' +
      'nothing; this leaves the bet alone -- they still win, they still bank the other ' +
      'half -- and simply pays you a share. A gamble like the theft is: back a loser and ' +
      'you get nothing. Cheap because it is half the money and they barely feel it. ' +
      'Blocked by Insurance.',
    // Takes a SHARE of the profit rather than diverting the payout, which is
    // why it can sit alongside Grand Theft without being the same boost.
    tithes: 0.5,
    blind: true,
    attack: true,
  },
  {
    kind: 'blind-sabotage',
    name: 'Blind Sabotage',
    icon: '🎯',
    cost: 18,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: 'Cuts 10% off a bet if it wins. Cheap because you are guessing.',
    detail:
      'The mildest attack, and the cheapest. You can see the stake and the price ' +
      'on the attack board, never the pick. Blocked by Insurance.',
    payoutCut: 0.1,
    attack: true,
  },
  {
    kind: 'void',
    name: 'The Void',
    icon: '🕳️',
    cost: 21,
    family: FAMILY.PAYOUT,
    target: TARGET.BET,
    blurb: 'Kills a bet outright. It pays nothing, to anybody.',
    detail:
      'Not a cut -- the whole thing. Their stake goes with it. Completely blind, ' +
      'like every other attack: kill a loser and you spent the points for nothing. ' +
      'Cheaper than Grand Theft because it does the same damage and pays you ' +
      'nothing -- this buys spite, not money. Blocked by Insurance.',
    // Total negation, not a percentage. The payout goes to zero rather than
    // being scaled, so this cannot be expressed as a multiplier like Skim.
    //
    // It used to carry settledOnly and cost MORE than Grand Theft, on the
    // theory that it was the one certain attack -- aimed at a bet already known
    // to have won. That was never true in the app: canAttach refuses any
    // settled bet and The Action only lists pending ones, so The Void was
    // always as blind as everything else. Identical damage to a theft, minus
    // the payout, means it has to be cheaper.
    negates: true,
    blind: true,
    attack: true,
  },
  {
    kind: 'week-curse',
    name: 'Because, Fuck You',
    icon: '🖕',
    cost: 48,
    family: FAMILY.PAYOUT,
    target: TARGET.BETTOR,
    blurb: 'Cuts 30% off everything one manager wins this week.',
    detail:
      'Not one bet -- all of them. Declared against a person before the games, so you ' +
      'are guessing at their whole week rather than picking off a single wager. ' +
      'Insurance shields a bet from it like any other attack.',
    payoutCut: 0.3,
    attack: true,
    // Hits a person for a week rather than a bet, so it is read at settlement
    // the same way Big Week is -- by (owner, week) rather than off the bet.
    weekWide: true,
  },
];

export const byKind = Object.fromEntries(BOOSTS.map((b) => [b.kind, b]));

/** Boosts that change a payout, in the order they are applied. */
export const PAYOUT_ORDER = [
  'boost-50',
  'boost-week',
  'blind-sabotage',
  'payout-cut',
  'week-curse',
  'void',
];

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

/**
 * Store grouping: attack, defence, and everything else.
 *
 * The flat list had grown to twenty and read as a wall. Grouping by what a
 * boost DOES is the split that matters when shopping -- you arrive wanting to
 * hit someone, or wanting to not be hit, and the third group is the toolkit you
 * use on your own position.
 *
 * Cheapest first inside each group, so the affordable end is always the part
 * you see first. Ties keep catalogue order, which keeps the listing stable
 * rather than reshuffling on every render.
 */
export const SHOP_GROUPS = [
  {
    key: 'attack',
    title: 'Attack',
    blurb: 'Used on somebody else. Mostly blind -- you are guessing at what you hit.',
    match: (b) => b.attack === true,
  },
  {
    key: 'defence',
    title: 'Defence',
    blurb: 'Stops a hit, returns one, or tells you who threw it.',
    match: (b) => b.defensive === true,
  },
  {
    key: 'self',
    title: 'Your own position',
    blurb: 'Price, payout and second thoughts on bets you have already made.',
    match: () => true,
  },
];

/** BOOSTS split into SHOP_GROUPS, cheapest first. Every boost lands in exactly one. */
export function groupedBoosts(list = BOOSTS) {
  const seen = new Set();
  return SHOP_GROUPS.map((g) => {
    const items = list
      .filter((b) => !seen.has(b.kind) && g.match(b))
      .map((b) => {
        seen.add(b.kind);
        return b;
      })
      // Stable: cost first, then catalogue order.
      .sort((a, b) => a.cost - b.cost || list.indexOf(a) - list.indexOf(b));
    return { ...g, items };
  }).filter((g) => g.items.length > 0);
}
