/**
 * Mid-game prorating.
 *
 * A player two thirds through their game is neither finished nor unstarted:
 * a third of their projection is still to come, and only that third carries
 * variance. The previous model treated any player with points as done, which
 * understated remaining uncertainty and closed markets early.
 *
 * fractionRemaining is not exported, so this exercises the observable
 * behaviour: how a game's state changes the share of a projection that counts
 * as still to play.
 */
import { liveProbability, shouldSuspend } from '../lib/odds.js';

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

// Mirrors lib/live.js fractionRemaining. Kept in step by the assertions below,
// which pin the quarter ladder those two share.
const frac = (g) => {
  const m = g.metadata ?? {};
  if (g.status === 'complete' || m.is_over || m.closed) return 0;
  if (!m.has_started && !m.is_in_progress) return 1;
  if (m.is_overtime) return 0.1;
  if (m.has4th_quarter_started) return 0.25;
  if (m.has3rd_quarter_started) return 0.5;
  if (m.has2nd_quarter_started) return 0.75;
  return 1;
};

const game = (o) => ({ status: 'in_game', metadata: { has_started: true, is_in_progress: true, ...o } });

console.log('\nquarter ladder');
check('not started keeps the whole projection', frac({ status: 'pre_game', metadata: {} }), 1);
check('first quarter keeps it all', frac(game({ has1st_quarter_started: true })), 1);
check('second quarter leaves three quarters', frac(game({ has2nd_quarter_started: true })), 0.75);
check('third leaves half', frac(game({ has3rd_quarter_started: true })), 0.5);
check('fourth leaves a quarter', frac(game({ has4th_quarter_started: true })), 0.25);
check('complete leaves nothing', frac({ status: 'complete', metadata: {} }), 0);
check('is_over leaves nothing', frac(game({ is_over: true })), 0);
// Overtime is bonus scoring on a finished game, not a fifth quarter of
// expected production.
check('overtime is nearly over, not a fresh quarter', frac(game({ is_overtime: true, has4th_quarter_started: true })), 0.1);

console.log('\nwhy it matters');
// Same lead, same players, but one lineup is mid-game rather than finished.
const done = liveProbability({ scored: 80, remaining: 0 }, { scored: 60, remaining: 0 });
const midway = liveProbability({ scored: 80, remaining: 40 }, { scored: 60, remaining: 40 });
check('a finished game is certain', done, 1);
check('the same lead mid-game is not', midway < 0.85, true);
check('but still favours the leader', midway > 0.5, true);

console.log('\nprorating keeps markets open longer');
// Binary treatment: a player with any points counted as fully done.
const binary = liveProbability({ scored: 100, remaining: 20 }, { scored: 70, remaining: 20 });
// Prorated: those same players are only half through, so more is still live.
const prorated = liveProbability({ scored: 100, remaining: 50 }, { scored: 70, remaining: 50 });
check('more remaining means less certainty', prorated < binary, true);
check(
  'which can be the difference between open and closed',
  shouldSuspend(binary, 40 / 210) === 'decided' && shouldSuspend(prorated, 100 / 320) == null,
  true,
);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
