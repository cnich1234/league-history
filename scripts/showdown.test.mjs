/**
 * Positional showdowns and alternate spreads.
 *
 * A showdown is a spread scoped to a position group: one manager's starting WRs
 * against the other's, with a handicap. Two things make it different from an
 * ordinary spread and both can lose real money if wrong:
 *
 *   - only STARTERS count. A 30-point WR on the bench scored his manager
 *     nothing and must not decide the bet.
 *   - a lineup that started nobody at the position VOIDS rather than losing.
 *     There was never a bet to win, so taking the stake would be theft.
 */
import { resolveMarket } from '../lib/settle.js';
import {
  h2hProbability,
  twoWayOdds,
  impliedProbability,
  fieldOdds,
  LEAGUE_SD,
} from '../lib/odds.js';

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

const POSITIONS = {
  wr1: 'WR', wr2: 'WR', wr3: 'WR', wr4: 'WR',
  rb1: 'RB', rb2: 'RB',
  te1: 'TE',
};
const positionOf = (id) => POSITIONS[id] ?? '?';

const HOME = 1;
const AWAY = 2;

const showdown = (position, spread, favouriteSide = 'home') => ({
  kind: 'showdown',
  meta: { position, homeRoster: HOME, awayRoster: AWAY, spread, favouriteSide },
});
const ctx = (starterRosters) => ({
  pointsByRoster: {}, pointsByPlayer: {}, startedPlayers: new Set(),
  starterRosters, positionOf,
});

console.log('\nthe favourite has to cover');
{
  // Home WRs 40.0, away WRs 32.0 -> margin 8, line 5.5.
  const starters = {
    wr1: { rosterId: HOME, points: 25.0 },
    wr2: { rosterId: HOME, points: 15.0 },
    wr3: { rosterId: AWAY, points: 20.0 },
    wr4: { rosterId: AWAY, points: 12.0 },
  };
  check('clears the line', resolveMarket(showdown('WR', 5.5), ctx(starters)), 'cover');
  check('does not clear a bigger one', resolveMarket(showdown('WR', 10.5), ctx(starters)), 'nocover');
}

console.log('\nthe underdog side');
{
  // Away favoured by the market, home actually outscores them.
  const starters = {
    wr1: { rosterId: HOME, points: 30.0 },
    wr2: { rosterId: AWAY, points: 10.0 },
  };
  check(
    'a favourite who loses outright does not cover',
    resolveMarket(showdown('WR', 4.5, 'away'), ctx(starters)),
    'nocover',
  );
  check(
    'and the same game from the other side covers',
    resolveMarket(showdown('WR', 4.5, 'home'), ctx(starters)),
    'cover',
  );
}

console.log('\nonly starters count');
{
  // wr4 would flip the result, but he is not in starterRosters -- benched.
  const starters = {
    wr1: { rosterId: HOME, points: 12.0 },
    wr3: { rosterId: AWAY, points: 20.0 },
  };
  check(
    'a benched player cannot win the bet',
    resolveMarket(showdown('WR', 2.5, 'away'), ctx(starters)),
    'cover',
  );
}

console.log('\nonly the named position counts');
{
  const starters = {
    wr1: { rosterId: HOME, points: 5.0 },
    rb1: { rosterId: HOME, points: 40.0 }, // huge, wrong position
    wr3: { rosterId: AWAY, points: 10.0 },
  };
  check(
    'an RB does not decide a WR battle',
    resolveMarket(showdown('WR', 1.5, 'home'), ctx(starters)),
    'nocover',
  );
}

console.log('\nvoids rather than guesses');
{
  check(
    'nobody started at that position on one side',
    resolveMarket(showdown('TE', 3.5), ctx({ te1: { rosterId: HOME, points: 9 } })),
    'void',
  );
  check(
    'nobody at all',
    resolveMarket(showdown('TE', 3.5), ctx({})),
    'void',
  );
  check(
    'no position lookup',
    resolveMarket(showdown('WR', 3.5), {
      ...ctx({ wr1: { rosterId: HOME, points: 9 } }),
      positionOf: null,
    }),
    'void',
  );
  // Zero is a real score and must NOT be confused with "did not start".
  check(
    'a group that scored zero still resolves',
    resolveMarket(
      showdown('WR', 1.5, 'away'),
      ctx({
        wr1: { rosterId: HOME, points: 0 },
        wr3: { rosterId: AWAY, points: 8 },
      }),
    ),
    'cover',
  );
}

console.log('\nblowout markets: three outcomes, two backable');
{
  // "Does EITHER team win by more than the line", one option per manager. The
  // third outcome -- a close game -- is the likeliest and pays nothing, which
  // is exactly what lets both backable sides be plus money.
  const HOME_R = 7;
  const AWAY_R = 9;
  const blowout = (spread) => ({
    kind: 'spread',
    meta: { blowout: true, homeRoster: HOME_R, awayRoster: AWAY_R, spread },
  });
  const scores = (home, away) => ({
    pointsByRoster: { [HOME_R]: home, [AWAY_R]: away },
    pointsByPlayer: {}, startedPlayers: new Set(),
  });

  check('home blows them out', resolveMarket(blowout(20.5), scores(140, 110)), String(HOME_R));
  check('away blows them out', resolveMarket(blowout(20.5), scores(110, 140)), String(AWAY_R));

  // The outcome that makes the prices work: nobody covers, everybody loses.
  check('a close game wins for nobody', resolveMarket(blowout(20.5), scores(120, 110)), 'nobody');
  check('and it is NOT a push', resolveMarket(blowout(20.5), scores(120, 110)) === 'push', false);
  check('exactly on the line does not cover', resolveMarket(blowout(20.5), scores(130.5, 110)), 'nobody');
  check('a hair over does', resolveMarket(blowout(20.5), scores(130.6, 110)), String(HOME_R));

  check('a missing score voids', resolveMarket(blowout(20.5), scores(120, null)), 'void');

  // A plain spread must be untouched by the blowout branch.
  const plain = {
    kind: 'spread',
    meta: { homeRoster: HOME_R, awayRoster: AWAY_R, homeSlug: 'h', favouriteSlug: 'h', spread: 6.5 },
  };
  check('an ordinary spread still covers', resolveMarket(plain, scores(130, 110)), 'cover');
  check('and still fails to', resolveMarket(plain, scores(115, 110)), 'nocover');
}

console.log('\nboth blowout sides can be plus money');
{
  // Pricing the two backable sides as a PAIR would be wrong: they sum to well
  // under 1, so twoWayOdds would quote both far too short. The unbackable
  // "neither" has to be in the field.
  const cdf = (points) => {
    const z = points / (LEAGUE_SD * Math.SQRT2) / Math.SQRT2;
    const s = z < 0 ? -1 : 1;
    const x = Math.abs(z);
    const t = 1 / (1 + 0.3275911 * x);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t * Math.exp(-x * x);
    return 0.5 * (1 + s * y);
  };
  const pHome = 1 - cdf(20.5);
  const pAway = cdf(-20.5);
  const neither = 1 - pHome - pAway;
  check('a close game is the likeliest outcome', neither > pHome && neither > pAway, true);

  const priced = fieldOdds({ home: pHome, away: pAway, nobody: neither });
  check('both sides pay plus money in an even matchup', priced.home > 0 && priced.away > 0, true);
  const book = impliedProbability(priced.home) + impliedProbability(priced.away) +
               impliedProbability(priced.nobody);
  check('the whole book holds ~4.5%', Math.abs(book - 1.045) < 0.01, true);

  // Pricing only the two backable sides against each other -- the mistake.
  const wrong = fieldOdds({ home: pHome, away: pAway });
  check('ignoring "neither" would quote far too short', wrong.home < priced.home, true);
}

console.log('\nalternate spreads are priced by the model');
{
  // A blowout line must get long odds, not a hand-picked number.
  const evenTeams = 120;
  for (const line of [20.5, 30.5, 40.5]) {
    const p = h2hProbability(evenTeams, evenTeams + line);
    const o = twoWayOdds(p);
    check(`-${line} is plus money`, o.home > 0, true);
  }
  const p20 = h2hProbability(evenTeams, evenTeams + 20.5);
  const p40 = h2hProbability(evenTeams, evenTeams + 40.5);
  check('a longer line pays more', twoWayOdds(p40).home > twoWayOdds(p20).home, true);
  check('and is less likely', p40 < p20, true);

  const book = impliedProbability(twoWayOdds(p20).home) + impliedProbability(twoWayOdds(p20).away);
  check('the book still holds ~4.5%', Math.abs(book - 1.045) < 0.01, true);
}

console.log('\nposition groups swing less than whole lineups');
{
  // The reason showdowns use a scaled SD: one TE is not a nine-man lineup, and
  // pricing him with LEAGUE_SD would make every battle a coin flip.
  const groupSd = (LEAGUE_SD / 3) * Math.sqrt(1);
  const pTight = h2hProbability(12, 12 + 5.5, groupSd);
  const pLoose = h2hProbability(12, 12 + 5.5, LEAGUE_SD);
  check('a scaled SD gives a sharper price', pTight < pLoose, true);
  check('and is not a coin flip', Math.abs(pLoose - 0.5) < Math.abs(pTight - 0.5), true);
}

console.log('\nwhich kinds trade live');
{
  // buildWeek never set markets.live -- it was set once by migrations 008/009
  // for the markets that existed then. Every week built afterwards came out
  // entirely non-live, so week 2's matchups would have shut at kickoff instead
  // of repricing. This mirrors the rule createMarket now applies.
  const isLive = ({ kind, meta }) =>
    kind === 'h2h' || kind === 'total' || (kind === 'spread' && !meta?.blowout);

  check('matchups trade live', isLive({ kind: 'h2h' }), true);
  check('spreads trade live', isLive({ kind: 'spread', meta: {} }), true);
  check('team totals trade live', isLive({ kind: 'total' }), true);
  check('props do not', isLive({ kind: 'prop' }), false);
  check('league-wide specials do not', isLive({ kind: 'special' }), false);
  check('position battles do not', isLive({ kind: 'showdown' }), false);
  // The exception among spreads: a three-outcome field the live spread model
  // cannot describe, so it stays pregame rather than being mispriced.
  check('blowouts do not, despite being spreads', isLive({ kind: 'spread', meta: { blowout: true } }), false);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
