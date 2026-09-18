/**
 * Props on players who will not play are voided, not left open.
 *
 * Nico Collins was ruled Out with a hamstring and his over/under kept taking
 * bets until Sunday. There is no honest answer to that market: the over cannot
 * win, and the under is free money for whoever read the injury report. Eleven
 * such props were live on the week 2 board and one already had a parlay leg on
 * the under.
 *
 * The line between "void it" and "leave it" is the whole decision, so it is
 * what these tests pin down. Pure: no database, no feed.
 */
import { isScratched, scratchedProps, SCRATCHED } from '../lib/scratched.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

console.log('\nwho counts as not playing');
ok('Out', isScratched('Out'), true);
ok('IR', isScratched('IR'), true);
ok('PUP', isScratched('PUP'), true);
ok('NA', isScratched('NA'), true);
ok('Suspended', isScratched('Sus'), true);
ok('COVID', isScratched('COV'), true);
// Sleeper uses Doubtful sparingly -- five players league-wide against seventy-
// four Questionable -- and it nearly always means out.
ok('Doubtful', isScratched('Doubtful'), true);

console.log('\nwho does NOT');
// The loosest and most common designation. Most of them play, and voiding on
// it would cancel half the board every week. A Questionable player who sits is
// a bad beat, which is football.
ok('Questionable is left alone', isScratched('Questionable'), false);
ok('a healthy player has no status', isScratched(null), false);
ok('an empty string is not a status', isScratched(''), false);
ok('an unknown string is not assumed fatal', isScratched('Probable'), false);

console.log('\npicking the markets to void');
{
  const players = {
    '1': { full_name: 'Nico Collins', injury_status: 'Out' },
    '2': { full_name: 'Healthy Man', injury_status: null },
    '3': { full_name: 'Zay Flowers', injury_status: 'Doubtful' },
    '4': { full_name: 'Maybe Guy', injury_status: 'Questionable' },
  };
  const markets = [
    { id: 10, kind: 'prop', status: 'open', title: 'Nico Collins o/u 18.5', meta: { playerId: '1', playerName: 'Nico Collins' } },
    { id: 11, kind: 'prop', status: 'open', title: 'Healthy Man o/u 12', meta: { playerId: '2' } },
    { id: 12, kind: 'prop', status: 'open', title: 'Zay Flowers o/u 16.5', meta: { playerId: '3' } },
    { id: 13, kind: 'prop', status: 'open', title: 'Maybe Guy o/u 9', meta: { playerId: '4' } },
  ];
  const hit = scratchedProps(markets, players);
  ok('the Out and Doubtful props are picked', hit.map((h) => h.id), [10, 12]);
  ok('and the healthy and questionable ones are not', hit.length, 2);
  ok('each carries the status, for the message', hit[0].status, 'Out');
  ok('and a name', hit[0].playerName, 'Nico Collins');
}

console.log('\nwhat it refuses to touch');
{
  const players = { '1': { injury_status: 'Out' } };
  ok(
    'a market that is not a prop',
    scratchedProps([{ id: 1, kind: 'h2h', status: 'open', meta: { playerId: '1' } }], players),
    [],
  );
  ok(
    'a prop that is already locked',
    scratchedProps([{ id: 1, kind: 'prop', status: 'locked', meta: { playerId: '1' } }], players),
    [],
  );
  ok(
    'a prop already voided',
    scratchedProps([{ id: 1, kind: 'prop', status: 'void', meta: { playerId: '1' } }], players),
    [],
  );
  ok(
    'a prop with no player id',
    scratchedProps([{ id: 1, kind: 'prop', status: 'open', meta: {} }], players),
    [],
  );
  ok(
    'a player the feed has never heard of',
    scratchedProps([{ id: 1, kind: 'prop', status: 'open', meta: { playerId: 'nope' } }], players),
    [],
  );
}

console.log('\nthe set itself');
ok('Questionable is deliberately absent', SCRATCHED.has('Questionable'), false);
ok('and Doubtful deliberately present', SCRATCHED.has('Doubtful'), true);

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
