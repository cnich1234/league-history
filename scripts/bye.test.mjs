/**
 * Bye weeks.
 *
 * Byes begin in week 5 and take four or five teams out at a time, so for most
 * of the season several starters in the league have no game. Two bugs met in
 * the live model and compounded:
 *
 *   - `projections[id] ?? 9` invented nine points for anyone missing from the
 *     projections map, which a bye player usually is.
 *   - `fractionRemaining(undefined)` returns 1, because an unknown game is
 *     treated as not yet kicked off rather than as no game at all.
 *
 * So a bye starter contributed a full nine points of "still to come" that could
 * never arrive. The result was not cosmetic: a lineup ten points down late in
 * the week with two bye starters priced at 73% to win instead of 10%, and the
 * market stayed open because the model believed eighteen points were coming.
 */
import { liveProbability, shouldSuspend, LEAGUE_SD } from '../lib/odds.js';

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

/**
 * The `sides()` calculation from lib/live.js, reproduced so a bye week can be
 * exercised without waiting for week 5. Kept deliberately close to the real
 * thing -- if that changes shape, this should be updated with it.
 */
function sides(starters, { projections, gameByTeam, teamOfPlayer, points = {} }) {
  let scored = 0;
  let remaining = 0;
  for (const id of starters) {
    scored += Number(points[id] ?? 0);
    const team = teamOfPlayer[id];
    const game = team ? gameByTeam[team] : null;
    if (team != null && game == null) continue; // on a bye
    const projection = projections[id] ?? 9;
    const left = game?.over ? 0 : 1;
    remaining += projection * left;
  }
  return { scored: Math.round(scored * 10) / 10, remaining: Math.round(remaining * 10) / 10 };
}

const playing = { metadata: { has_started: false }, status: 'pre_game' };

console.log('\na bye starter contributes nothing');
{
  const ctx = {
    projections: { a: 20, b: 15, c: 12 },
    teamOfPlayer: { a: 'KC', b: 'SF', c: 'GB' },
    // GB is absent: they are on a bye.
    gameByTeam: { KC: playing, SF: playing },
  };
  const s = sides(['a', 'b', 'c'], ctx);
  check('only the two who play are counted', s.remaining, 35);

  // The specific bug: 'c' is not in projections either, so the old code gave
  // them the 9-point placeholder AND a full fraction remaining.
  const noProjection = {
    ...ctx,
    projections: { a: 20, b: 15 },
  };
  check('and a bye player missing from projections adds nothing', sides(['a', 'b', 'c'], noProjection).remaining, 35);
}

console.log('\nan unknown player still gets a placeholder');
{
  // Ignorance is not evidence of a bye: a player with no identifiable team
  // should not silently vanish from a lineup that does have people playing.
  const s = sides(['a', 'x'], {
    projections: { a: 20 },
    teamOfPlayer: { a: 'KC' },
    gameByTeam: { KC: playing },
  });
  check('unknown team keeps the 9-point placeholder', s.remaining, 29);
}

console.log('\nthe probability damage this caused');
{
  // Ten points down late in the week, two starters on a bye.
  const trueSide = { scored: 115, remaining: 5 };
  const phantomSide = { scored: 115, remaining: 5 + 18 };
  const opponent = { scored: 125, remaining: 5 };

  const truth = liveProbability(trueSide, opponent);
  const phantom = liveProbability(phantomSide, opponent);

  check('the real position is nearly lost', truth < 0.15, true);
  check('the phantom position looked like a favourite', phantom > 0.7, true);
  check('which is the wrong side of even money', truth < 0.5 && phantom > 0.5, true);

  // And the consequence that costs money: the market stays open.
  const totalTrue = trueSide.scored + trueSide.remaining + opponent.scored + opponent.remaining;
  const totalPhantom = phantomSide.scored + phantomSide.remaining + opponent.scored + opponent.remaining;
  const shareTrue = (trueSide.remaining + opponent.remaining) / totalTrue;
  const sharePhantom = (phantomSide.remaining + opponent.remaining) / totalPhantom;

  check('truthfully it should suspend', shouldSuspend(truth, shareTrue) != null, true);
  check('with phantoms it kept taking bets', shouldSuspend(phantom, sharePhantom), null);
}

console.log('\na whole lineup on a bye');
{
  // Degenerate but must not divide by zero or invent a result.
  const s = sides(['a', 'b'], {
    projections: { a: 20, b: 15 },
    teamOfPlayer: { a: 'GB', b: 'CHI' },
    gameByTeam: {},
  });
  check('nothing remains', s.remaining, 0);
  const p = liveProbability({ scored: 100, remaining: 0 }, { scored: 90, remaining: 0 });
  check('and a finished lead is certain', p, 1);
}

console.log('\nscored points are never discarded');
{
  // A player who already played and is now on a bye the FOLLOWING week is not
  // this case, but a mid-week correction could zero a team's remaining while
  // points are on the board. Those points must survive.
  const s = sides(['a', 'b'], {
    projections: { a: 20, b: 15 },
    teamOfPlayer: { a: 'GB', b: 'CHI' },
    gameByTeam: {},
    points: { a: 22.5, b: 8 },
  });
  check('the scoreboard is untouched', s.scored, 30.5);
  check('even with nothing left to play', s.remaining, 0);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
