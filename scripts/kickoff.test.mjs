/**
 * Has a game actually started?
 *
 * This exists because Sleeper sets `has1st_quarter_started: true` on games that
 * have NOT kicked off. SF@LAR carried it at 8am Arizona for a 5:35pm kickoff --
 * status "pre_game", empty quarter, is_in_progress false, and that one flag
 * saying otherwise.
 *
 * Trusting it locked six props hours early and published a bet on The Floor
 * while the game was still ahead of everyone. Twice.
 *
 * A quarter flag is fine for asking how FAR along a running game is. It is not
 * evidence that a game began.
 */
import { hasKickedOff, fractionRemaining } from '../lib/live.js';

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

const game = (status, metadata = {}) => ({ status, metadata });

console.log('\nthe exact payload that caused this');
{
  // Verbatim from api.sleeper.com/scores/nfl/regular/2026/1, SF@LAR, 8:17am AZ.
  const sfLar = game('pre_game', {
    home_team: 'LAR',
    away_team: 'SF',
    is_over: false,
    is_in_progress: false,
    has_started: false,
    has1st_quarter_started: true,
    has2nd_quarter_started: false,
    has3rd_quarter_started: false,
    quarter: '',
    date_time: '2026-09-11T00:35:00+00:00',
  });
  check('pre_game beats a bogus quarter flag', hasKickedOff(sfLar), false);
  check('and nothing has been played yet', fractionRemaining(sfLar), 1);
}

console.log('\nordinary pre-game');
{
  const g = game('pre_game', { has_started: false, is_in_progress: false });
  check('not started', hasKickedOff(g), false);
  check('everything still to come', fractionRemaining(g), 1);
}

console.log('\nactually underway');
{
  const q1 = game('in_game', { has_started: true, is_in_progress: true, has1st_quarter_started: true });
  check('has_started means started', hasKickedOff(q1), true);
  check('first quarter, all still to play', fractionRemaining(q1), 1);

  const q3 = game('in_game', {
    has_started: true, is_in_progress: true,
    has1st_quarter_started: true, has2nd_quarter_started: true, has3rd_quarter_started: true,
  });
  check('third quarter is half done', fractionRemaining(q3), 0.5);

  const ot = game('in_game', { has_started: true, is_in_progress: true, is_overtime: true });
  check('overtime is nearly over', fractionRemaining(ot), 0.1);
}

console.log('\nfinished');
{
  const done = game('complete', { is_over: true });
  check('complete counts as kicked off', hasKickedOff(done), true);
  check('nothing left', fractionRemaining(done), 0);

  // A finished game still carries every quarter flag; is_over must win.
  const flags = game('complete', {
    is_over: true, has1st_quarter_started: true, has2nd_quarter_started: true,
    has3rd_quarter_started: true, has4th_quarter_started: true,
  });
  check('quarter flags do not resurrect a final game', fractionRemaining(flags), 0);
}

console.log('\nmissing data');
{
  check('no game at all is not kicked off', hasKickedOff(null), false);
  check('and has everything to play', fractionRemaining(null), 1);
  check('no metadata', hasKickedOff(game('pre_game')), false);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
