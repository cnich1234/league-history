/**
 * groupByMatchup must never lose a market, and must never file one under the
 * wrong game.
 *
 * Two bugs have lived here. Pairings were built from the open h2h markets only,
 * so once a matchup locked, every still-open prop belonging to it was silently
 * dropped -- five of ten Week 1 props vanished from the board. Then, once they
 * came back, cards were split by lock day, which meant one matchup appeared
 * under several headings; the league found that convoluted.
 *
 * A card is now one matchup holding every bet on that game, open or closed,
 * with each bet carrying its own lock date.
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

// One day in the past so it is reliably locked, one in the future so it is not.
const PAST = new Date(Date.now() - 86400e3).toISOString();
const FUTURE = new Date(Date.now() + 86400e3).toISOString();

const all = [
  mk(1, 'h2h', { homeRoster: 1, awayRoster: 2 }, PAST),
  mk(2, 'spread', { homeRoster: 1, awayRoster: 2 }, PAST),
  mk(3, 'total', { rosterId: 1 }, PAST),
  mk(4, 'prop', { rosterId: 1 }, FUTURE),
  mk(5, 'prop', { rosterId: 2 }, FUTURE),
  mk(6, 'h2h', { homeRoster: 3, awayRoster: 4 }, FUTURE),
  mk(7, 'prop', { rosterId: 3 }, FUTURE),
];

console.log('\nnothing is lost');
const games = groupByMatchup(all, all);
check('every market attaches somewhere', games.reduce((n, g) => n + g.marketCount, 0), all.length);
check('one card per matchup', games.length, 2);

console.log('\none card holds every bet on a game');
const card = games.find((g) => g.key === '1-2');
check('regardless of when they lock', card.marketCount, 5);
check('including the closed h2h', card.markets.h2h.length, 1);
check('and the open props', card.markets.prop.length, 2);
check('open count excludes locked markets', card.openCount, 2);

console.log('\nprops survive their matchup locking');
// The original bug: asking for only the open markets must still find a home
// for props whose h2h has already closed.
const open = all.filter((m) => m.locks_at === FUTURE);
const partial = groupByMatchup(open, all);
check('nothing dropped', partial.reduce((n, g) => n + g.marketCount, 0), open.length);
const stillThere = partial.find((g) => g.key === '1-2');
check('the locked matchup still appears', stillThere?.marketCount, 2);
check('holding only what is open', stillThere?.markets.h2h.length, 0);

console.log('\nsorting');
check(
  'open markets come before closed ones within a kind',
  card.markets.total.map((m) => m.locks_at === PAST),
  [true],
);
const mixed = groupByMatchup(
  [mk(8, 'prop', { rosterId: 1 }, PAST), mk(9, 'prop', { rosterId: 1 }, FUTURE), ...all],
  all,
);
const props = mixed.find((g) => g.key === '1-2').markets.prop;
check('open props first', props[0].locks_at === FUTURE, true);
check('closed props last', props[props.length - 1].locks_at === PAST, true);

console.log('\nempty groups are dropped');
const onlyOne = groupByMatchup([all[6]], all);
check('a game with nothing in it is not rendered', onlyOne.length, 1);
check('and it is the right one', onlyOne[0].key, '3-4');

console.log('\norphans');
const orphan = mk(99, 'prop', { rosterId: 99 }, FUTURE);
const withOrphan = groupByMatchup([...open, orphan], all);
check(
  'a market with no pairing is dropped, not misattached',
  withOrphan.reduce((n, g) => n + g.marketCount, 0),
  open.length,
);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
