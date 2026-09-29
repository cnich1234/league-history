/**
 * The Market's cron touches the database every minute only while it matters.
 *
 * A query every minute kept Neon's compute awake around the clock and ran the
 * free plan's monthly allowance out on 2026-09-29, taking The Book down with
 * it. Pure: no database, no feed.
 */
import { tickCadence, shouldTick, LEAD_MS } from '../lib/market/cadence.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failed++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${pass ? '' : ` -- got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};

const NOW = Date.parse('2026-10-04T15:30:00Z'); // a Sunday morning
const HOUR = 60 * 60 * 1000;
const pre = (startsIn) => ({ status: 'pre_game', start_time: NOW + startsIn, metadata: { has_started: false } });
const live = () => ({ status: 'in_game', start_time: NOW - HOUR, metadata: { has_started: true, quarter_num: 2 } });
const final = () => ({ status: 'complete', start_time: NOW - 4 * HOUR, metadata: { has_started: true, is_over: true } });

console.log('\nwhen the Market needs every minute');
ok('a game in progress', tickCadence([final(), live(), pre(10 * HOUR)], NOW), 'hot');
ok('a kickoff within the lead time', tickCadence([pre(90 * 60 * 1000)], NOW), 'hot');
ok('right at the edge of the lead time', tickCadence([pre(LEAD_MS)], NOW), 'hot');
ok('a game past kickoff but not reporting live yet', tickCadence([pre(-20 * 60 * 1000)], NOW), 'hot');
ok('the scores feed as an object, not an array', tickCadence({ a: live() }, NOW), 'hot');
ok('a kickoff given only as metadata.date_time',
  tickCadence([{ status: 'pre_game', metadata: { date_time: new Date(NOW + HOUR).toISOString() } }], NOW), 'hot');

console.log('\nwhen it does not');
ok('a Tuesday: the next game is days away', tickCadence([pre(50 * HOUR), pre(96 * HOUR)], NOW), 'quiet');
ok('Sunday night after the last game', tickCadence([final(), final()], NOW), 'quiet');
ok('an empty week', tickCadence([], NOW), 'quiet');
ok('no feed at all', tickCadence(null, NOW), 'quiet');
ok('a long-stale pre_game row is not treated as a delayed kickoff', tickCadence([pre(-10 * HOUR)], NOW), 'quiet');

console.log('\nwhat that means per minute');
ok('hot: every minute', shouldTick('hot', Date.parse('2026-10-04T15:37:00Z')), true);
ok('quiet: on the hour', shouldTick('quiet', Date.parse('2026-10-06T14:00:20Z')), true);
ok('quiet: not otherwise', shouldTick('quiet', Date.parse('2026-10-06T14:01:00Z')), false);
{
  let runs = 0;
  for (let m = 0; m < 24 * 60; m++) if (shouldTick('quiet', Date.parse('2026-10-06T00:00:00Z') + m * 60_000)) runs++;
  ok('a quiet day touches the database 24 times, not 1,440', runs, 24);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
