/**
 * How a bet WOULD settle, before settlement runs.
 *
 * The Action shows bets whose games are over but whose money has not moved --
 * the cron runs Tuesday and the last game ends Monday night. For that day the
 * page said only "Closed", which is true and useless.
 *
 * The danger in showing a result early is showing the WRONG one, so these
 * tests pin the projection to the same answers settlement gives. Pure: the
 * scoring inputs are injected, no feed and no database.
 */
import { standingResults } from '../lib/standing.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

// Roster 5 scored 120, roster 9 scored 100. Home wins by 20.
const INPUTS = {
  pointsByRoster: { 5: 120, 9: 100 },
  pointsByPlayer: { p1: 22, p2: 4 },
  startedPlayers: new Set(['p1', 'p2']),
  starterRosters: { p1: { rosterId: 5, points: 22 }, p2: { rosterId: 9, points: 4 } },
  positionOf: () => 'WR',
};
const load = async () => INPUTS;
const noScores = async () => null;

const h2h = { kind: 'h2h', meta: { homeRoster: 5, awayRoster: 9 }, season: 2026, week: 2 };
const prop = (line) => ({ kind: 'prop', meta: { line, playerId: 'p1' }, season: 2026, week: 2 });

console.log('\na straight bet, called from the final score');
{
  const r = await standingResults([{ id: 1, optionKey: 'home', market: h2h }], load);
  ok('backing the winner reads won', r[1], 'won');
}
{
  const r = await standingResults([{ id: 2, optionKey: 'away', market: h2h }], load);
  ok('backing the loser reads lost', r[2], 'lost');
}
{
  const r = await standingResults([{ id: 3, optionKey: 'over', market: prop(18.5) }], load);
  ok('a prop over the line', r[3], 'won');
  const r2 = await standingResults([{ id: 4, optionKey: 'under', market: prop(18.5) }], load);
  ok('and the under on the same line', r2[4], 'lost');
}

console.log('\nbefore there are any scores');
{
  const r = await standingResults([{ id: 5, optionKey: 'home', market: h2h }], noScores);
  ok('nothing is claimed', r, {});
}

console.log('\na parlay needs every leg');
{
  const bothWin = {
    id: 10,
    legs: [
      { optionKey: 'home', market: h2h },
      { optionKey: 'over', market: prop(18.5) },
    ],
  };
  ok('all legs won', (await standingResults([bothWin], load))[10], 'won');
}
{
  const oneLost = {
    id: 11,
    legs: [
      { optionKey: 'home', market: h2h },
      { optionKey: 'under', market: prop(18.5) },
    ],
  };
  ok('one lost leg kills it', (await standingResults([oneLost], load))[11], 'lost');
}
{
  // The losing leg is second: the answer must not depend on the order.
  const lostFirst = {
    id: 12,
    legs: [
      { optionKey: 'under', market: prop(18.5) },
      { optionKey: 'home', market: h2h },
    ],
  };
  ok('order does not matter', (await standingResults([lostFirst], load))[12], 'lost');
}
{
  // A leg whose week has no scores leaves the parlay undecided, even though
  // its other leg has won. Saying "won" there would be a lie.
  const nextWeek = { kind: 'h2h', meta: { homeRoster: 5, awayRoster: 9 }, season: 2026, week: 3 };
  const straddle = {
    id: 13,
    legs: [
      { optionKey: 'home', market: h2h },
      { optionKey: 'home', market: nextWeek },
    ],
  };
  const loader = async (season, week) => (week === 2 ? INPUTS : null);
  ok('an unplayed leg leaves it open', (await standingResults([straddle], loader))[13], undefined);
}

console.log('\npushes and voids');
{
  // A tie pushes: resolveMarket returns 'push' and the stake comes back.
  const tied = {
    pointsByRoster: { 5: 100, 9: 100 },
    pointsByPlayer: {},
    startedPlayers: new Set(),
    starterRosters: {},
    positionOf: () => '?',
  };
  const r = await standingResults([{ id: 20, optionKey: 'home', market: h2h }], async () => tied);
  ok('a tie is a push', r[20], 'push');
}
{
  // A void leg drops out of the parlay rather than killing it, which is what
  // settleParlays does -- the remaining legs carry it.
  const voidLeg = { kind: 'h2h', meta: { homeRoster: 99, awayRoster: 98 }, season: 2026, week: 2 };
  const withVoid = {
    id: 21,
    legs: [
      { optionKey: 'home', market: h2h },
      { optionKey: 'home', market: voidLeg },
    ],
  };
  ok('a void leg does not kill a winning parlay', (await standingResults([withVoid], load))[21], 'won');
}
{
  // Every leg void: there is nothing left to win.
  const allVoid = {
    id: 22,
    legs: [
      { optionKey: 'home', market: { kind: 'h2h', meta: { homeRoster: 99, awayRoster: 98 }, season: 2026, week: 2 } },
    ],
  };
  ok('all legs void is a void', (await standingResults([allVoid], load))[22], 'void');
}

console.log('\nit reads one week once');
{
  let calls = 0;
  const counting = async (s, w) => {
    calls++;
    return INPUTS;
  };
  await standingResults(
    [
      { id: 30, optionKey: 'home', market: h2h },
      { id: 31, optionKey: 'away', market: h2h },
      { id: 32, optionKey: 'over', market: prop(18.5) },
    ],
    counting,
  );
  ok('three bets on one week is one fetch', calls, 1);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
