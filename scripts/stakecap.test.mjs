/**
 * Live stake limits.
 *
 * A $250 bet on a coin flip and a $250 bet on something 88% decided are not
 * the same wager. Real books shrink limits as certainty rises; none publishes
 * a formula, so this taper is a deliberate choice and worth pinning down.
 */
import { maxLiveStake, MIN_STAKE_CENTS, MAX_STAKE_CENTS } from '../lib/odds.js';
import { livePrice } from '../lib/live.js';

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

console.log('\nfull limit while it is a contest');
check('a coin flip takes the maximum', maxLiveStake(0.5), MAX_STAKE_CENTS);
check('60% still takes the maximum', maxLiveStake(0.6), MAX_STAKE_CENTS);
check('75% is the last full-limit point', maxLiveStake(0.75), MAX_STAKE_CENTS);

console.log('\ntapering');
check('80% is reduced', maxLiveStake(0.8) < MAX_STAKE_CENTS, true);
check('85% is roughly half', Math.abs(maxLiveStake(0.85) - 9000) < 1000, true);
check('88% is small', maxLiveStake(0.88) < 5000, true);
check('at the threshold it is the minimum', maxLiveStake(0.9), MIN_STAKE_CENTS);
check('past the threshold stays at the minimum', maxLiveStake(0.97), MIN_STAKE_CENTS);

console.log('\nmonotonic and symmetric');
const ladder = [0.5, 0.7, 0.8, 0.85, 0.9].map(maxLiveStake);
check(
  'the cap never rises as certainty rises',
  ladder.every((v, i) => i === 0 || v <= ladder[i - 1]),
  true,
);
// An 88% favourite and a 12% underdog are the same market from two sides.
check('a big underdog caps like its favourite', maxLiveStake(0.12), maxLiveStake(0.88));
check('an even market is symmetric too', maxLiveStake(0.5), maxLiveStake(0.5));

console.log('\nalways bettable while open');
check(
  'never drops below the minimum stake',
  [0.5, 0.8, 0.89, 0.899, 0.95].every((p) => maxLiveStake(p) >= MIN_STAKE_CENTS),
  true,
);
check('caps land on whole dollars', maxLiveStake(0.83) % 100, 0);

console.log('\nthe priced market carries its own cap');
// No live matchup is usually past 75%, so this uses a constructed state to
// exercise the path that actually gates placement.
const lopsided = {
  homeRoster: 1,
  awayRoster: 2,
  home: { scored: 120, remaining: 20 },
  away: { scored: 80, remaining: 20 },
  probability: 0.86,
  suspended: false,
};
const priced = livePrice({ kind: 'h2h', meta: { homeRoster: 1, awayRoster: 2 } }, lopsided);
check('a lopsided market still prices', priced != null, true);
check('and carries a reduced cap', priced.maxStakeCents < MAX_STAKE_CENTS, true);
check('matching the taper exactly', priced.maxStakeCents, maxLiveStake(0.86));

const even = livePrice(
  { kind: 'h2h', meta: { homeRoster: 1, awayRoster: 2 } },
  { ...lopsided, probability: 0.55 },
);
check('a close market keeps the full cap', even.maxStakeCents, MAX_STAKE_CENTS);


console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
