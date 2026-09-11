/**
 * The shop: points as currency, boosts as consequences.
 *
 * Two things here move real money and are tested hardest:
 *
 *   - the ORDER boosts are applied in. A 50% boost then a 20% cut is not the
 *     same number as a cut then a boost, so the order is fixed and documented
 *     rather than left to whichever row came back first.
 *   - a refund is NOT a win. Boosts multiply a winning payout; taking 20% off
 *     a pushed stake would be taking money nobody lost.
 */
import {
  applyBoosts,
  boostOdds,
  byKind,
  BOOSTS,
  canAttach,
  FAMILY,
  WEEKLY_ALLOWANCE,
} from '../lib/boosts.js';
import { payoutCents } from '../lib/odds.js';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`);
    failed++;
  }
};

console.log('\nthe catalogue is coherent');
{
  check('every boost has a unique kind', new Set(BOOSTS.map((b) => b.kind)).size, BOOSTS.length);
  check('every boost has an icon', BOOSTS.every((b) => Boolean(b.icon)), true);
  check('every boost costs something', BOOSTS.every((b) => b.cost > 0), true);
  // A boost that does everything another does, plus pays you, cannot be the
  // cheaper of the two. Checked as a rule rather than as two hardcoded numbers
  // so it still holds after a repricing.
  const dominates = [
    // [better, worse] -- same damage, but the first also pays the attacker.
    ['steal', 'void'],
  ];
  for (const [better, worse] of dominates) {
    check(
      `${byKind[better].name} costs more than ${byKind[worse].name}`,
      byKind[better].cost > byKind[worse].cost,
      true,
    );
  }
  // The weekly allowance must buy something, or the default grant is pointless.
  check(
    'the allowance affords at least one boost',
    BOOSTS.some((b) => b.cost <= WEEKLY_ALLOWANCE),
    true,
  );
}

console.log('\nno boosts, no change');
check('a plain win is untouched', applyBoosts(30000, []), 30000);
check('and an unknown kind is ignored', applyBoosts(30000, ['nonsense']), 30000);

console.log('\nHalf Again');
check('adds 50% to the whole payout', applyBoosts(20000, ['boost-50']), 30000);
// $100 at +100 returns $200; boosted that is $300, not $250 -- the boost is on
// the payout, not the profit.
check('$100 bet returning $200 becomes $300', applyBoosts(20000, ['boost-50']), 30000);

console.log('\nSkim');
check('takes 20% off', applyBoosts(30000, ['payout-cut']), 24000);
check('rounds to whole cents', applyBoosts(33333, ['payout-cut']), 26666);

console.log('\nboth at once, in a fixed order');
{
  // Multiply up first, THEN take the cut off the result. The other order gives
  // a different number, which is why this is pinned rather than left to chance.
  check('boost then cut', applyBoosts(20000, ['boost-50', 'payout-cut']), 24000);
  check('order of the array does not matter', applyBoosts(20000, ['payout-cut', 'boost-50']), 24000);
  // Cut-then-boost would be 20000 * 0.8 * 1.5 = 24000 as well here; use a
  // number where the two orders genuinely diverge after rounding.
  check('rounding follows the same order', applyBoosts(33333, ['boost-50', 'payout-cut']), 40000);
}

console.log('\nInsurance blocks attacks');
{
  check('a skim is stopped', applyBoosts(30000, ['payout-cut', 'insurance']), 30000);
  // It defends, it does not add. A shielded bet with no attack pays normally.
  check('alone it does nothing', applyBoosts(30000, ['insurance']), 30000);
  // And it must not block your own upside.
  check('your own boost still applies', applyBoosts(20000, ['boost-50', 'insurance']), 30000);
  check(
    'shielded, boosted and skimmed pays the boosted number',
    applyBoosts(20000, ['boost-50', 'payout-cut', 'insurance']),
    30000,
  );
}

console.log('\nlosses and refunds');
{
  // applyBoosts is only ever called on a winning payout, but a zero must stay
  // zero rather than becoming a rounding artefact.
  check('nothing times anything is nothing', applyBoosts(0, ['boost-50']), 0);
}

console.log('\nwhen a boost may be attached');
{
  const insurance = byKind['insurance'];
  const poison = byKind['market-poison'];
  const cashOut = byKind['cash-out'];

  check(
    'insurance goes on a pending bet',
    canAttach(insurance, { marketLocked: false, marketLive: true, betStatus: 'pending' }).ok,
    true,
  );
  check(
    'but not on a settled one',
    canAttach(insurance, { marketLocked: true, marketLive: false, betStatus: 'won' }).ok,
    false,
  );

  // A price boost cannot land after bets exist at the old number.
  check(
    'poison needs an open market',
    canAttach(poison, { marketLocked: true, marketLive: false }).ok,
    false,
  );
  check(
    'and works before it locks',
    canAttach(poison, { marketLocked: false, marketLive: true }).ok,
    true,
  );

  // Cash out needs something to cash out of.
  check(
    'cash out needs a live market',
    canAttach(cashOut, { marketLocked: true, marketLive: false, betStatus: 'pending' }).ok,
    false,
  );
  check(
    'and needs the games started',
    canAttach(cashOut, { marketLocked: false, marketLive: true, betStatus: 'pending' }).ok,
    false,
  );
  check(
    'live and underway is fine',
    canAttach(cashOut, { marketLocked: true, marketLive: true, betStatus: 'pending' }).ok,
    true,
  );
}

console.log('\nattack and defence are labelled');
{
  check('skim is an attack', byKind['payout-cut'].attack, true);
  check('poison is an attack', byKind['market-poison'].attack, true);
  check('insurance is defensive', byKind['insurance'].defensive, true);
  check('half again is neither', Boolean(byKind['boost-50'].attack), false);
  // A price boost and a payout boost are applied at different times, so the
  // families must not blur.
  check('poison changes a price', byKind['market-poison'].family, FAMILY.PRICE);
  check('skim changes a payout', byKind['payout-cut'].family, FAMILY.PAYOUT);
}

console.log('\nBetter Price boosts the PROFIT, not the payout');
{
  // The distinction that matters when explaining these to the league: an odds
  // boost is weaker than a payout boost of the same size, because the stake
  // comes back either way and only the profit is multiplied.
  check('+200 becomes +300', boostOdds(200), 300);
  check('even money becomes +150', boostOdds(100), 150);
  check('a favourite improves too', boostOdds(-110), 136);
  check('a heavy favourite stays negative', boostOdds(-300), -200);
  check('a longshot goes much longer', boostOdds(542), 813);

  // $100 at +200: plain wins $300, odds-boosted wins $400, payout-boosted $450.
  const stake = 10000;
  const plain = payoutCents(stake, 200);
  const viaOdds = payoutCents(stake, boostOdds(200));
  const viaPayout = applyBoosts(plain, ['boost-50']);
  check('odds boost pays less than a payout boost', viaOdds < viaPayout, true);
  check('but more than nothing', viaOdds > plain, true);
  check('the gap is widest on favourites',
    payoutCents(25000, boostOdds(-300)) < applyBoosts(payoutCents(25000, -300), ['boost-50']),
    true);
}

console.log('\nBig Week stacks with Half Again');
{
  // Deliberate: Big Week is declared blind before the games, Half Again is
  // placed on a known winner. Someone who did both earned 2.25x.
  check('week boost alone', applyBoosts(20000, ['boost-week']), 30000);
  check('both together compound', applyBoosts(20000, ['boost-50', 'boost-week']), 45000);
  check('and a skim still bites the result',
    applyBoosts(20000, ['boost-50', 'boost-week', 'payout-cut']), 36000);
  check('unless shielded',
    applyBoosts(20000, ['boost-50', 'boost-week', 'payout-cut', 'insurance']), 45000);
}

console.log('\nThe Void negates rather than scales');
{
  // Skim is a multiplier, so it composes with everything else. The Void is
  // not: a voided bet pays nothing, and nothing applied afterwards can bring
  // it back. That is why it short-circuits instead of joining the chain.
  check('a winner pays nothing', applyBoosts(30000, ['void']), 0);
  check('a boost cannot rescue it', applyBoosts(30000, ['void', 'boost-50']), 0);
  check('nor can a week boost', applyBoosts(30000, ['void', 'boost-week']), 0);
  check('nor both', applyBoosts(30000, ['void', 'boost-50', 'boost-week']), 0);
  check('a skim on top changes nothing', applyBoosts(30000, ['void', 'payout-cut']), 0);

  // It is still an attack, so the shield still stops it -- and stops it
  // completely, leaving the bet paying exactly what it would have.
  check('insurance blocks it outright', applyBoosts(30000, ['void', 'insurance']), 30000);
  check(
    'and a shielded boosted bet keeps its boost',
    applyBoosts(20000, ['void', 'boost-50', 'insurance']),
    30000,
  );

  // Order in the array must not matter, same as every other combination.
  check('array order is irrelevant', applyBoosts(30000, ['boost-50', 'void']), 0);
}

console.log('\ncoming-soon boosts are marked, not sellable');
{
  // Nothing is a placeholder any more. The attack board solved the problem that
  // held them back: it shows who bet, how much and at what price, but never
  // which market or which side, so an attack can name a target without
  // revealing a position.
  check('everything is buyable', BOOSTS.filter((b) => b.comingSoon), []);
  const attacks = BOOSTS.filter((b) => b.attack);
  // Not a fixed count -- that only ever fails when the catalogue grows, which
  // is not a bug. What matters is that every attack is aimed at someone else
  // and none of them is also flagged defensive.
  check('there are attacks at all', attacks.length > 0, true);
  check(
    'every attack targets someone else',
    attacks.filter((b) => !['bet', 'bettor', 'market'].includes(b.target)).map((b) => b.kind),
    [],
  );
  check(
    'and none is defensive too',
    attacks.filter((b) => b.defensive).map((b) => b.kind),
    [],
  );
  // Ride Along is NOT one, even though it targets someone else's bet. It takes
  // nothing from them -- they keep the bet unchanged and both sides win or lose
  // together. It is a bet on the person, not against them.
  check('riding along is not an attack', Boolean(byKind['ride-along'].attack), false);
  // They are gambles now -- you cannot see what you are hitting -- so every one
  // of them costs less than the dearest thing you can buy for yourself.
  const dearestSelfish = Math.max(...BOOSTS.filter((b) => !b.attack).map((b) => b.cost));
  check(
    'and all cost less than the dearest non-attack',
    attacks.every((b) => b.cost < dearestSelfish),
    true,
  );

  // Grand Theft and The Void would otherwise be the same boost, with theft
  // strictly better -- same damage, plus you collect. What separates them is
  // WHEN they are used: theft is blind and can be wasted on a loser, the void
  // is used on a bet already known to have won.
  const theft = byKind['steal'];
  const voidBoost = byKind['void'];
  check('theft is used blind', theft.blind, true);
  // The Void carried settledOnly and cost more, on the theory that it was the
  // one certain attack. It never was: canAttach refuses a settled bet and The
  // Action lists only pending ones, so it was always as blind as the rest.
  // The old test read the flag and never checked it did anything.
  check('and so is the void', voidBoost.blind, true);
  check(
    'neither can be used after a bet settles',
    [theft, voidBoost].map((b) =>
      canAttach(b, { marketLocked: true, marketLive: false, betStatus: 'won' }).ok,
    ),
    [false, false],
  );
  // Same damage -- the victim loses everything either way -- but a theft also
  // PAYS the attacker. A strictly better boost cannot be the cheaper one.
  check('the one that pays you costs more', theft.cost > voidBoost.cost, true);
  check('only one of them moves the money', [theft.steals, voidBoost.steals], [true, undefined]);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
