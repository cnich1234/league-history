/**
 * Money math has to be exactly right. A rounding error that pays a dollar too
 * much on every settled bet is invisible for a week and indefensible by
 * November.
 */
import {
  payoutCents, profitCents, impliedProbability, probabilityToOdds,
  twoWayOdds, h2hProbability, formatMoney, formatOdds,
  MIN_STAKE_CENTS, MAX_STAKE_CENTS,
} from '../lib/odds.js';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); failed++; }
};
const near = (label, actual, expected, tol = 0.005) => {
  if (Math.abs(actual - expected) <= tol) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}\n      expected ~${expected}\n      got      ${actual}`); failed++; }
};

console.log('\npayouts');
// $100 at +150 wins $150, returns $250.
check('+150 on $100 returns $250', payoutCents(10000, 150), 25000);
// $150 at -150 wins $100, returns $250.
check('-150 on $150 returns $250', payoutCents(15000, -150), 25000);
check('even money +100 doubles', payoutCents(10000, 100), 20000);
check('even money -100 doubles', payoutCents(10000, -100), 20000);
check('profit excludes stake', profitCents(10000, 150), 15000);
check('heavy favourite pays little', profitCents(10000, -500), 2000);
check('longshot pays big', profitCents(10000, 900), 90000);

console.log('\nrounding');
// Odd amounts must never produce fractional cents.
check('odd stake stays integral', Number.isInteger(payoutCents(3333, -137)), true);
check('payout is never below stake', payoutCents(1000, -10000) >= 1000, true);

console.log('\nprobability');
near('-110 implies ~52.4%', impliedProbability(-110), 0.5238);
near('+100 implies 50%', impliedProbability(100), 0.5);
near('+200 implies 33.3%', impliedProbability(200), 0.3333);
check('50% is even money', probabilityToOdds(0.5), -100);
check('75% is a favourite', probabilityToOdds(0.75) < 0, true);
check('25% is an underdog', probabilityToOdds(0.25) > 0, true);
check('round trip holds', Math.abs(impliedProbability(probabilityToOdds(0.65)) - 0.65) < 0.01, true);

console.log('\nline making');
const even = twoWayOdds(0.5);
check('even game prices both sides the same', even.home, even.away);
check('even game is juiced, not +100', even.home < -100, true);
const lopsided = twoWayOdds(0.8);
check('favourite is negative', lopsided.home < 0, true);
check('underdog is positive', lopsided.away > 0, true);
// The book's edge: both implied probabilities must sum above 1.
const sum = impliedProbability(even.home) + impliedProbability(even.away);
check('vig makes probabilities sum > 1', sum > 1.02, true);

console.log('\nhead to head');
near('equal projections is a coin flip', h2hProbability(120, 120), 0.5);
check('higher projection favoured', h2hProbability(130, 110) > 0.5, true);
// A 20-point edge is real but far from decisive in fantasy.
const p20 = h2hProbability(130, 110);
check('20-point edge is 65-75%, not 95%', p20 > 0.65 && p20 < 0.75, true);
check('symmetric', Math.abs(h2hProbability(130, 110) + h2hProbability(110, 130) - 1) < 1e-9, true);

console.log('\nformatting');
check('money', formatMoney(123456), '$1,234.56');
check('zero', formatMoney(0), '$0.00');
check('negative', formatMoney(-5000), '$-50.00');
check('positive odds get a plus', formatOdds(150), '+150');
check('negative odds keep the minus', formatOdds(-150), '-150');

console.log('\nlimits');
check('minimum is $10', MIN_STAKE_CENTS, 1000);
check('maximum is $250', MAX_STAKE_CENTS, 25000);
check('max is a quarter of the opening bankroll', MAX_STAKE_CENTS * 4, 100000);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
