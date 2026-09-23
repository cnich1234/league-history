/**
 * What a writeup may say about the side games.
 *
 * Week 2 of 2026 was the first week of betting, daily fantasy, points and the
 * Market, and the recap written for it mentioned none of them -- the context
 * carried only football. Adding them re-opens a question that has already been
 * got wrong once: some of these numbers are public and some are not, and they
 * look alike.
 *
 * The line is RESULT vs POSITION.
 *
 *   result    what somebody DID -- a settled bet, a daily fantasy placing, a
 *             trophy, the points those earned. Public: The Action shows every
 *             slip once a market locks, /dfs opens after settlement, and
 *             /trophies is a page anyone can read.
 *   position  what somebody HOLDS -- Market shares, a points balance. Private,
 *             for the reason a bet is hidden before its market locks: a
 *             visible position gets copied, and a balance tells the league
 *             what somebody can afford to bet next week.
 *
 * The first draft of the week 2 preview named a manager beside his share
 * counts. That is the failure this guards.
 */
import { buildWriteupContext } from '../lib/writeup-context.js';
import { checkPrivacy } from '../lib/writeup-verify.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

const context = await buildWriteupContext({ kind: 'recap', season: 2026, week: 2 });
const g = context.games;

console.log('\nthe side games reach the writer at all');
ok('there is a games block', g != null, true);
ok('betting results are there', (g?.betting?.seasonToDate ?? []).length > 0, true);
ok('the daily contest is there', g?.daily?.field?.length > 0, true);
ok('trophies are there', (g?.trophies ?? []).length > 0, true);
ok('and the week\'s points', Object.keys(g?.pointsEarned?.byManager ?? {}).length > 0, true);

console.log('\ndaily fantasy lineups are whole');
{
  // Fetching with live:false left every player at 0.00 while the entry totals
  // stayed correct -- the worst shape available, trustworthy-looking and wrong
  // in every detail. Each lineup summing to its own total catches that.
  const bad = (g.daily.field ?? []).filter((e) => {
    const sum = (e.lineup ?? []).reduce((n, p) => n + Number(p.points ?? 0), 0);
    return Math.abs(sum - Number(e.points)) > 0.01;
  });
  ok('every lineup sums to its entry total', bad.map((e) => e.manager), []);
  ok('nobody is scoreless', (g.daily.field ?? []).filter((e) => Number(e.points) === 0).length, 0);
  ok('every entry has a full lineup', (g.daily.field ?? []).every((e) => e.lineup.length === 8), true);
}

console.log('\nmanagers are named, not slugged');
{
  // Only the MANAGER fields matter. Achievement ids are hyphenated too
  // (top-score, worst-te) and are meant to be -- an earlier version of this
  // test flagged all 22 of them and said nothing about managers.
  const managers = [
    ...g.trophies.map((t) => t.manager),
    ...g.betting.seasonToDate.map((b) => b.manager),
    ...g.daily.field.map((e) => e.manager),
    ...Object.keys(g.pointsEarned.byManager),
  ];
  const slugged = [...new Set(managers.filter((m) => /^[a-z]+-[a-z]+$/.test(String(m))))];
  ok('every manager is a display name, not a slug', slugged, []);
  ok('and they are real people', new Set(managers).size >= 8, true);
}

console.log('\npositions never reach the writer');
{
  const blob = JSON.stringify(context);
  ok('no point balances anywhere', /point_balances|"balance"/.test(blob), false);
  // The market summary is the one place holdings appear, and it is anonymous.
  ok('the market summary carries no owner', /"owner"/.test(JSON.stringify(context.book)), false);
  ok('it does carry the totals worth writing about', context.book.marketSummary.totalShares > 0, true);
}

console.log('\nthe privacy gate knows which is which');
{
  const pad = ' '.repeat(900);
  const blocked = (md) => checkPrivacy(md + pad, context).length > 0;
  // Positions: must be stopped.
  ok('a named share count is blocked', blocked('Kevin holds 43 shares of Chase.'), true);
  ok('a named balance is blocked', blocked('Devin has 118 points to spend next week.'), true);
  // Results: must be allowed, or half the league's week is unwritable.
  ok('an anonymous market total passes', blocked('Five traders hold 98 shares between them.'), false);
  ok('a named trophy passes', blocked('Kevin took the top-score trophy for 171.08.'), false);
  ok('a named daily win passes', blocked('Chris won the daily with 151.12.'), false);
  ok('a named bet result passes', blocked('Mike R is 1-0 on the season and up $1,434.'), false);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
