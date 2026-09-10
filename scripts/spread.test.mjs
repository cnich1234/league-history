/**
 * Spread pricing must stay coherent with the moneyline.
 *
 * Covering -4.5 is strictly harder than winning by any margin, so P(cover) must
 * always be below P(win). It was not: spread markets were generated without a
 * `homeSlug`, so `favouriteSlug === homeSlug` compared a string to undefined,
 * came out false every time, and every spread priced the AWAY team as the
 * favourite. A slight underdog to win was showing as a favourite to cover.
 *
 * Caught by a bettor reading the board, not by any test -- hence this file.
 */
import { liveProbability, liveSpreadProbability } from '../lib/odds.js';
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

// Home is modestly ahead: the realistic case, and the one that broke.
const state = {
  homeRoster: 1,
  awayRoster: 2,
  home: { scored: 40, remaining: 120 },
  away: { scored: 0, remaining: 138 },
  suspended: false,
};
state.probability = liveProbability(state.home, state.away);

const spreadMeta = (favouriteIsHome, spread) => ({
  homeRoster: 1,
  awayRoster: 2,
  homeSlug: 'home-team',
  awaySlug: 'away-team',
  favouriteSlug: favouriteIsHome ? 'home-team' : 'away-team',
  underdogSlug: favouriteIsHome ? 'away-team' : 'home-team',
  spread,
});

console.log('\ncovering is harder than winning');
for (const favIsHome of [true, false]) {
  const side = favIsHome ? 'home' : 'away';
  const pWin = favIsHome ? state.probability : 1 - state.probability;
  const priced = livePrice({ kind: 'spread', meta: spreadMeta(favIsHome, 4.5) }, state);
  check(
    `${side} favourite: P(cover) is below P(win)`,
    priced.probability < pWin,
    true,
  );
}

console.log('\nthe favourite is read from the right side');
// The bug: with homeSlug missing the comparison was always false, so a home
// favourite was priced as if the away team were favoured.
const homeFav = livePrice({ kind: 'spread', meta: spreadMeta(true, 4.5) }, state);
const awayFav = livePrice({ kind: 'spread', meta: spreadMeta(false, 4.5) }, state);
check('the two are not the same market', homeFav.probability !== awayFav.probability, true);
check(
  'the side that is ahead is likelier to cover',
  homeFav.probability > awayFav.probability,
  true,
);

console.log('\na missing homeSlug is caught, not silently mispriced');
const broken = { ...spreadMeta(true, 4.5), homeSlug: undefined };
let threw = null;
try {
  livePrice({ kind: 'spread', meta: broken }, state);
} catch (e) {
  threw = e.message;
}
check('throws rather than guessing', threw != null, true);

console.log('\nbigger lines are harder');
const lines = [0.5, 4.5, 10.5, 20.5].map(
  (n) => livePrice({ kind: 'spread', meta: spreadMeta(true, n) }, state).probability,
);
check(
  'P(cover) falls as the line rises',
  lines.every((p, i) => i === 0 || p <= lines[i - 1]),
  true,
);

console.log('\nagainst the raw model');
check(
  'livePrice agrees with liveSpreadProbability',
  Math.abs(
    livePrice({ kind: 'spread', meta: spreadMeta(true, 4.5) }, state).probability -
      liveSpreadProbability(state.home, state.away, 4.5),
  ) < 1e-9,
  true,
);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
