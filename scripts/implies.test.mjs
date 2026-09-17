/**
 * Legs that guarantee other legs.
 *
 * Chris built Devin +4.5, Devin by 20.5+ and Devin by 30.5+ and the slip quoted
 * +3278. All three win exactly when the hardest one does, so the honest price
 * was +397 -- the book would have paid 8.26x for a single result. Stacking all
 * four margin markets on one roster reaches 35x.
 *
 * A parlay multiplies because its legs are assumed to be separate questions.
 * These tests pin down when they are not. Pure, so no database.
 */
import { claimOf, implies, redundantLegs } from '../lib/implies.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

// Ernie (roster 5) hosts Devin (roster 9); Ernie is the 4.5-point favourite.
const h2h = { kind: 'h2h', meta: { homeRoster: 5, awayRoster: 9 } };
const spread = {
  kind: 'spread',
  meta: { spread: 4.5, homeRoster: 5, awayRoster: 9, homeSlug: 'ernie', favouriteSlug: 'ernie' },
};
const blow20 = { kind: 'spread', meta: { spread: 20.5, blowout: true, homeRoster: 5, awayRoster: 9 } };
const blow30 = { kind: 'spread', meta: { spread: 30.5, blowout: true, homeRoster: 5, awayRoster: 9 } };

console.log('\nwhat a pick actually claims');
ok('backing the home side is margin > 0', claimOf(h2h, 'home'), { kind: 'margin', team: '5', gt: 0 });
ok('backing the away side is their own margin', claimOf(h2h, 'away'), { kind: 'margin', team: '9', gt: 0 });
ok('the favourite covering is margin > the line', claimOf(spread, 'cover'), {
  kind: 'margin',
  team: '5',
  gt: 4.5,
});
ok('the dog covering is margin > minus the line', claimOf(spread, 'nocover'), {
  kind: 'margin',
  team: '9',
  gt: -4.5,
});
ok('a blowout option is the named roster', claimOf(blow30, '9'), { kind: 'margin', team: '9', gt: 30.5 });
ok('a total makes no margin claim', claimOf({ kind: 'total', meta: { line: 130 } }, 'over'), null);

console.log('\nthe exact parlay that started this');
{
  const legs = [
    { marketId: 1, optionKey: 'nocover', market: spread }, // Devin +4.5
    { marketId: 2, optionKey: '9', market: blow20 }, // Devin by 20.5+
    { marketId: 3, optionKey: '9', market: blow30 }, // Devin by 30.5+
  ];
  const nested = redundantLegs(legs);
  ok('two of the three legs are redundant', nested.length, 2);
  ok(
    'and the hardest leg is the one kept',
    nested.every((n) => n.redundant.marketId !== 3),
    true,
  );
}

console.log('\nthe implication chain, both directions');
ok('by 30.5+ guarantees by 20.5+', implies(claimOf(blow30, '9'), claimOf(blow20, '9')), true);
ok('by 20.5+ does NOT guarantee by 30.5+', implies(claimOf(blow20, '9'), claimOf(blow30, '9')), false);
ok('by 20.5+ guarantees the win', implies(claimOf(blow20, '9'), claimOf(h2h, 'away')), true);
ok('winning guarantees covering +4.5', implies(claimOf(h2h, 'away'), claimOf(spread, 'nocover')), true);
ok('by 30.5+ guarantees covering +4.5', implies(claimOf(blow30, '9'), claimOf(spread, 'nocover')), true);

console.log('\nopposite sides are not implications');
ok('Ernie big does not guarantee Devin anything', implies(claimOf(blow30, '5'), claimOf(blow20, '9')), false);
ok('and Devin covering does not imply Ernie covering', implies(claimOf(spread, 'nocover'), claimOf(spread, 'cover')), false);

console.log('\ngenuinely separate questions still parlay');
{
  const otherGame = {
    kind: 'spread',
    meta: { spread: 8.5, blowout: true, homeRoster: 1, awayRoster: 6 },
  };
  const legs = [
    { marketId: 1, optionKey: '9', market: blow30 },
    { marketId: 2, optionKey: '1', market: otherGame },
  ];
  ok('two different matchups are fine', redundantLegs(legs), []);
}
{
  // Both sides of one matchup cannot both win, so neither implies the other.
  const legs = [
    { marketId: 1, optionKey: 'cover', market: spread },
    { marketId: 2, optionKey: '9', market: blow20 },
  ];
  ok('opposite sides are not flagged as redundant', redundantLegs(legs), []);
}

console.log('\nprops on the same player nest too');
{
  const gibbs = (line) => ({ kind: 'prop', meta: { line, playerId: '11584' } });
  const other = { kind: 'prop', meta: { line: 12, playerId: '99999' } };
  ok('over 26 guarantees over 16', implies(claimOf(gibbs(26), 'over'), claimOf(gibbs(16), 'over')), true);
  ok('over 16 does not guarantee over 26', implies(claimOf(gibbs(16), 'over'), claimOf(gibbs(26), 'over')), false);
  ok('under 7 guarantees under 12', implies(claimOf(gibbs(7), 'under'), claimOf(gibbs(12), 'under')), true);
  ok('over and under never imply each other', implies(claimOf(gibbs(26), 'over'), claimOf(gibbs(16), 'under')), false);
  ok('different players never nest', implies(claimOf(gibbs(26), 'over'), claimOf(other, 'over')), false);
  const legs = [
    { marketId: 1, optionKey: 'over', market: gibbs(26) },
    { marketId: 2, optionKey: 'over', market: gibbs(16) },
  ];
  ok('stacking two overs on one player is caught', redundantLegs(legs).length, 1);
}

console.log('\nthe worst stack available: all four margin markets on one roster');
{
  const legs = [
    { marketId: 1, optionKey: 'nocover', market: spread },
    { marketId: 2, optionKey: 'away', market: h2h },
    { marketId: 3, optionKey: '9', market: blow20 },
    { marketId: 4, optionKey: '9', market: blow30 },
  ];
  const nested = redundantLegs(legs);
  ok('three of the four are redundant', nested.length, 3);
  ok('only the 30.5 leg survives', nested.every((n) => n.redundant.marketId !== 4), true);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
