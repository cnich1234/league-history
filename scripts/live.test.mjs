/**
 * Live win probability.
 *
 * The model is Stern (1994): variance is additive over time, so the standard
 * deviation of what remains scales with sqrt(remaining share). What makes this
 * worth testing carefully is that the same margin has to mean wildly different
 * things depending on when it happens -- a 30-point lead on Thursday night is
 * nearly meaningless and on Sunday evening is decisive. Getting that backwards
 * would hand out free money.
 */
import { liveProbability, liveSpreadProbability, shouldSuspend } from '../lib/odds.js';

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
const near = (label, actual, expected, tol = 0.02) => {
  if (Math.abs(actual - expected) <= tol) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}\n         expected ~${expected}\n         got      ${actual.toFixed(4)}`);
    failed++;
  }
};

console.log('\nbefore anything is played');
near('even projections is a coin flip', liveProbability({ scored: 0, remaining: 130 }, { scored: 0, remaining: 130 }), 0.5);
check(
  'matches the pre-game model when nothing has scored',
  Math.abs(
    liveProbability({ scored: 0, remaining: 140 }, { scored: 0, remaining: 120 }) - 0.7141,
  ) < 0.01,
  true,
);

console.log('\nthe same lead means different things');
const thursday = liveProbability({ scored: 30, remaining: 110 }, { scored: 0, remaining: 130 });
const sunday = liveProbability({ scored: 110, remaining: 20 }, { scored: 80, remaining: 20 });
check('a 30-point Thursday lead is far from decided', thursday < 0.7, true);
check('the same lead late is near-certain', sunday > 0.95, true);
check('later is always more certain for the same margin', sunday > thursday, true);

console.log('\nremaining scoring drives the uncertainty');
// Identical margin, progressively less left to play.
const shrinking = [0.9, 0.5, 0.25, 0.1].map((share) => {
  const rem = 260 * share;
  const scored = (260 - rem) / 2;
  return liveProbability({ scored: scored + 15, remaining: rem / 2 }, { scored: scored - 15, remaining: rem / 2 });
});
check(
  'probability rises monotonically as less remains',
  shrinking.every((p, i) => i === 0 || p >= shrinking[i - 1]),
  true,
);

console.log('\nedge cases');
check('nothing left and ahead is certain', liveProbability({ scored: 130, remaining: 0 }, { scored: 120, remaining: 0 }), 1);
check('nothing left and behind is zero', liveProbability({ scored: 120, remaining: 0 }, { scored: 130, remaining: 0 }), 0);
check('nothing left and tied is even', liveProbability({ scored: 120, remaining: 0 }, { scored: 120, remaining: 0 }), 0.5);
near('trailing badly late is near zero', liveProbability({ scored: 80, remaining: 5 }, { scored: 130, remaining: 5 }), 0, 0.01);
check(
  'symmetric: swapping sides gives the complement',
  Math.abs(
    liveProbability({ scored: 60, remaining: 60 }, { scored: 40, remaining: 70 }) +
      liveProbability({ scored: 40, remaining: 70 }, { scored: 60, remaining: 60 }) -
      1,
  ) < 1e-9,
  true,
);

console.log('\nspreads');
// Favourite leads by 20 with a 6.5 line: covering is likelier than not.
const covering = liveSpreadProbability({ scored: 100, remaining: 20 }, { scored: 80, remaining: 20 }, 6.5);
check('a lead beyond the line favours the cover', covering > 0.5, true);
// Same lead, a line it has not cleared.
const notCovering = liveSpreadProbability({ scored: 100, remaining: 20 }, { scored: 80, remaining: 20 }, 30.5);
check('a lead short of the line favours the dog', notCovering < 0.5, true);
check('a bigger line is always harder to cover', notCovering < covering, true);

console.log('\nsuspension');
check('an even market stays open', shouldSuspend(0.5, 0.5), null);
check('a 70/30 market stays open', shouldSuspend(0.7, 0.4), null);
check('90% closes the market', shouldSuspend(0.9, 0.4), 'decided');
check('10% closes it from the other side', shouldSuspend(0.1, 0.4), 'decided');
// Even a coin flip closes once there is almost nothing left to play, because
// the model is least trustworthy exactly there.
check('too little left to play closes it regardless', shouldSuspend(0.5, 0.05), 'decided');
check('threshold is configurable', shouldSuspend(0.92, 0.4, { threshold: 0.95 }), null);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
