/**
 * League-wide "best in the league this week" markets.
 *
 * These settle differently from everything else: the option key is a roster id
 * rather than a side, and the winner is decided by comparing every manager at
 * once. Two rules carry the weight:
 *
 *   - only STARTERS count. A 40-point RB on someone's bench did not earn his
 *     manager a single point and must not win him the bet either.
 *   - ties push. Two managers can genuinely share a high score, and picking one
 *     arbitrarily would take money off someone who was not wrong.
 */
import { resolveMarket } from '../lib/settle.js';
import { fieldOdds, impliedProbability } from '../lib/odds.js';

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

// Four managers. Positions are assigned by id prefix so the fixture reads.
const POSITIONS = {
  rb1: 'RB', rb2: 'RB', rb3: 'RB', rb4: 'RB',
  wr1: 'WR', wr2: 'WR',
  te1: 'TE', te2: 'TE',
};
const positionOf = (id) => POSITIONS[id] ?? '?';

const team = (market, meta) => ({ kind: 'special', meta: { special: 'team', ...meta } });
const position = (pos) => ({ kind: 'special', meta: { special: 'position', position: pos } });

console.log('\nhighest scoring team');
{
  const pointsByRoster = { 1: 120.5, 2: 143.2, 3: 98.0, 4: 131.4 };
  check(
    'the top score wins',
    resolveMarket(team(), { pointsByRoster, starterRosters: {}, positionOf }),
    '2',
  );
  check(
    'a tie pushes',
    resolveMarket(team(), {
      pointsByRoster: { 1: 143.2, 2: 143.2, 3: 98.0 },
      starterRosters: {},
      positionOf,
    }),
    'push',
  );
  check(
    'no scores at all voids',
    resolveMarket(team(), { pointsByRoster: {}, starterRosters: {}, positionOf }),
    'void',
  );
}

console.log('\nhighest scoring RB');
{
  // Roster 3 has the highest-scoring RB in the league.
  const starterRosters = {
    rb1: { rosterId: 1, points: 18.4 },
    rb2: { rosterId: 2, points: 22.1 },
    rb3: { rosterId: 3, points: 31.7 },
    wr1: { rosterId: 4, points: 40.0 }, // a WR, must not win the RB market
  };
  check(
    'the top starting RB wins it for his manager',
    resolveMarket(position('RB'), { pointsByRoster: {}, starterRosters, positionOf }),
    '3',
  );
  check(
    'a higher-scoring WR does not win the RB market',
    resolveMarket(position('WR'), { pointsByRoster: {}, starterRosters, positionOf }),
    '4',
  );
}

console.log('\nbenched players do not count');
{
  // rb4 outscores everyone but is not in starterRosters at all -- he was on a
  // bench, so he earned his manager nothing and cannot win this either.
  const starterRosters = {
    rb1: { rosterId: 1, points: 18.4 },
    rb2: { rosterId: 2, points: 22.1 },
  };
  check(
    'only starters are considered',
    resolveMarket(position('RB'), { pointsByRoster: {}, starterRosters, positionOf }),
    '2',
  );
}

console.log('\nties and gaps');
{
  check(
    'two managers tied at the top pushes',
    resolveMarket(position('RB'), {
      pointsByRoster: {},
      starterRosters: {
        rb1: { rosterId: 1, points: 25.0 },
        rb2: { rosterId: 2, points: 25.0 },
        rb3: { rosterId: 3, points: 11.0 },
      },
      positionOf,
    }),
    'push',
  );
  check(
    'one manager starting two tied RBs still wins outright',
    // Same roster twice is not a tie between managers -- there is one winner.
    resolveMarket(position('RB'), {
      pointsByRoster: {},
      starterRosters: {
        rb1: { rosterId: 1, points: 25.0 },
        rb2: { rosterId: 1, points: 25.0 },
        rb3: { rosterId: 3, points: 11.0 },
      },
      positionOf,
    }),
    '1',
  );
  check(
    'nobody started that position, so nothing can be decided',
    resolveMarket(position('TE'), {
      pointsByRoster: {},
      starterRosters: { rb1: { rosterId: 1, points: 25.0 } },
      positionOf,
    }),
    'void',
  );
  check(
    'a zero-point winner is still a winner',
    resolveMarket(position('TE'), {
      pointsByRoster: {},
      starterRosters: { te1: { rosterId: 5, points: 0 } },
      positionOf,
    }),
    '5',
  );
}

console.log('\nmissing data voids rather than guesses');
{
  check(
    'no position on the market',
    resolveMarket(
      { kind: 'special', meta: { special: 'position' } },
      { pointsByRoster: {}, starterRosters: { rb1: { rosterId: 1, points: 9 } }, positionOf },
    ),
    'void',
  );
  check(
    'no position lookup available',
    resolveMarket(position('RB'), {
      pointsByRoster: {},
      starterRosters: { rb1: { rosterId: 1, points: 9 } },
      positionOf: null,
    }),
    'void',
  );
}

console.log('\npricing a field of more than two');
{
  const weights = { 1: 120, 2: 118, 3: 130, 4: 110, 5: 125 };
  const prices = fieldOdds(weights);
  check('one price per entrant', Object.keys(prices).length, 5);
  const book = Object.values(prices).reduce((a, o) => a + impliedProbability(o), 0);
  // The whole point: a ten-way book must sum to 1 + margin, which twoWayOdds
  // cannot do because it splits a margin across exactly two sides.
  check('the book holds 4.5%', Math.abs(book - 1.045) < 0.002, true);
  check(
    'the strongest entrant is the shortest price',
    prices['3'] < prices['4'],
    true,
  );
  check('an empty field prices nothing', fieldOdds({}), {});
  const even = fieldOdds({ 1: 0, 2: 0, 3: 0 });
  check('a field with no information is priced evenly', even['1'] === even['3'], true);
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
