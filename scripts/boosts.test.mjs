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
import { applyBoosts, byKind, BOOSTS, canAttach, FAMILY, WEEKLY_ALLOWANCE } from '../lib/boosts.js';

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

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
