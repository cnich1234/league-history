/**
 * Which side wins, given final scores. Pure logic, no database.
 *
 * These are the decisions that move real bankrolls, and several of them are
 * easy to get backwards -- a spread where the favourite is the away team, a
 * total landing exactly on its line, a prop for a player who never played.
 */
import { resolveMarket } from '../lib/settle.js';

let failed = 0;
const check = (label, actual, expected) => {
  if (actual === expected) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}\n         expected ${expected}\n         got      ${actual}`); failed++; }
};

const ctx = {
  pointsByRoster: { 1: 120.5, 2: 100.0, 3: 95.25, 4: 95.25, 5: 140.0 },
  pointsByPlayer: { p1: 24.5, p2: 8.0, p3: 20.0, benched: 30.0 },
  startedPlayers: new Set(['p1', 'p2', 'p3']),
};
const r = (kind, meta) => resolveMarket({ kind, meta }, ctx);

console.log('\nhead to head');
check('home outscores away', r('h2h', { homeRoster: 1, awayRoster: 2 }), 'home');
check('away outscores home', r('h2h', { homeRoster: 2, awayRoster: 1 }), 'away');
check('exact tie is a push', r('h2h', { homeRoster: 3, awayRoster: 4 }), 'push');
check('missing roster voids', r('h2h', { homeRoster: 1, awayRoster: 99 }), 'void');

console.log('\nspreads');
// Home 120.5 vs away 100.0 -> home wins by 20.5.
check(
  'favourite covers a small spread',
  r('spread', { homeRoster: 1, awayRoster: 2, homeSlug: 'h', favouriteSlug: 'h', spread: 3.5 }),
  'cover',
);
check(
  'favourite fails a big spread',
  r('spread', { homeRoster: 1, awayRoster: 2, homeSlug: 'h', favouriteSlug: 'h', spread: 25.5 }),
  'nocover',
);
// The favourite is the AWAY team here -- the margin has to flip with it.
check(
  'away favourite covers',
  r('spread', { homeRoster: 2, awayRoster: 1, homeSlug: 'h', favouriteSlug: 'a', spread: 10.5 }),
  'cover',
);
check(
  'away favourite fails',
  r('spread', { homeRoster: 2, awayRoster: 1, homeSlug: 'h', favouriteSlug: 'a', spread: 30.5 }),
  'nocover',
);
check(
  'underdog winning outright never covers',
  r('spread', { homeRoster: 2, awayRoster: 1, homeSlug: 'h', favouriteSlug: 'h', spread: 3.5 }),
  'nocover',
);

console.log('\ntotals');
check('score above the line is over', r('total', { rosterId: 1, line: 100.5 }), 'over');
check('score below the line is under', r('total', { rosterId: 2, line: 120.5 }), 'under');
// Half-point lines make this impossible in practice, but the rule must still
// be unambiguous: strictly greater is over.
check('exactly on the line is under', r('total', { rosterId: 2, line: 100.0 }), 'under');
check('missing roster voids', r('total', { rosterId: 99, line: 100 }), 'void');

console.log('\nplayer props');
check('player clears the line', r('prop', { playerId: 'p1', line: 20.5 }), 'over');
check('player misses the line', r('prop', { playerId: 'p2', line: 20.5 }), 'under');
check('exactly on the line is under', r('prop', { playerId: 'p3', line: 20.0 }), 'under');
// The important one: a benched player never had a chance, so settling the
// bet as "under" would punish someone for a lineup decision they did not make.
check('benched player voids, not under', r('prop', { playerId: 'benched', line: 20.5 }), 'void');
check('unknown player voids', r('prop', { playerId: 'nobody', line: 20.5 }), 'void');

console.log('\nunknown kinds');
check('unrecognised kind returns null', r('futures', {}), null);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
