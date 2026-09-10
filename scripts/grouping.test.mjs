/**
 * groupByMatchup must never lose a market, and must never file one under the
 * wrong day.
 *
 * Two bugs live here. Pairings were built from the open h2h markets only, so
 * once a matchup locked, every still-open prop belonging to it was silently
 * dropped -- five of ten Week 1 props vanished from the board. Then, once they
 * came back, a card was placed by its earliest market, so a Sunday prop showed
 * under a Thursday heading because it shared a game with a Thursday spread.
 *
 * A card is therefore one (matchup, lock day) pair, holding only the bets that
 * actually close on that day.
 */
import { groupByMatchup } from '../lib/book.js';

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

const mk = (id, kind, meta, locks) => ({
  id,
  kind,
  meta,
  title: `${kind} ${id}`,
  locks_at: locks,
});

const EARLY = '2026-09-09T07:00:00Z';
const LATE = '2026-09-13T07:00:00Z';

const all = [
  mk(1, 'h2h', { homeRoster: 1, awayRoster: 2 }, EARLY),
  mk(2, 'spread', { homeRoster: 1, awayRoster: 2 }, EARLY),
  mk(3, 'total', { rosterId: 1 }, EARLY),
  mk(4, 'prop', { rosterId: 1 }, LATE),
  mk(5, 'prop', { rosterId: 2 }, LATE),
  mk(6, 'h2h', { homeRoster: 3, awayRoster: 4 }, LATE),
  mk(7, 'prop', { rosterId: 3 }, LATE),
];

console.log('\nnothing is lost');
const everything = groupByMatchup(all, all);
check(
  'all markets attach when everything is open',
  everything.reduce((n, g) => n + g.marketCount, 0),
  all.length,
);

// The bug: matchup 1-2 has locked, but its props are still open.
const open = all.filter((m) => m.locks_at === LATE);
const partial = groupByMatchup(open, all);
check(
  'props survive their matchup locking',
  partial.reduce((n, g) => n + g.marketCount, 0),
  open.length,
);
const lateCard = partial.find((g) => g.key.startsWith('1-2@'));
check('the locked matchup still appears, holding its open props', lateCard?.marketCount, 2);
check('and shows no h2h, because that one locked', lateCard?.markets.h2h.length, 0);

console.log('\nsplit by lock day');
// Matchup 1-2 has markets on both days; it must produce two separate cards.
const split = groupByMatchup(all, all).filter((g) => g.key.startsWith('1-2@'));
check('one card per lock day', split.length, 2);
check('earliest card first', split[0].locksAt, EARLY);
check('early card holds only early markets', split[0].marketCount, 3);
check('late card holds only late markets', split[1].marketCount, 2);
check(
  'no market appears on both days',
  split[0].markets.prop.length + split[1].markets.h2h.length,
  0,
);
check('both cards keep the matchup title', split[0].title === split[1].title, true);

console.log('\nempty groups are dropped');
const onlyOne = groupByMatchup([all[6]], all);
check('a game with nothing open is not rendered', onlyOne.length, 1);
check('and it is the right one', onlyOne[0].key.startsWith('3-4@'), true);

console.log('\nordering and shape');
check(
  'sorted by lock day',
  everything.map((g) => g.locksAt),
  [EARLY, LATE, LATE],
);
check(
  'a locked matchup sorts by what is left in it',
  partial.map((g) => g.locksAt),
  [LATE, LATE],
);

console.log('\norphans');
const orphan = mk(9, 'prop', { rosterId: 99 }, LATE);
const withOrphan = groupByMatchup([...open, orphan], all);
check(
  'a market with no pairing is dropped, not misattached',
  withOrphan.reduce((n, g) => n + g.marketCount, 0),
  open.length,
);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
