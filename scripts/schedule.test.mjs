/**
 * Lock timing. The rule is KICKOFF of the earliest game a market depends on,
 * and the consequence of getting it wrong runs both ways: lock late and
 * somebody bets a game they have already watched, lock early and a whole
 * betting day disappears for no reason.
 *
 * Both failures have now happened. The early one was 2026-09-17, when the
 * entire Thursday board closed at midnight for a game that kicked off at 5:15
 * that afternoon.
 */
import { lockInstantFor, lockTimeFor, latestKickoff, gameDayFor } from '../lib/schedule.js';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`); failed++; }
};

/** A week shaped like a real one: Thursday night, Sunday, Sunday night, Monday. */
const at = (iso) => new Date(iso);
const WEEK = {
  BUF: { date: '2026-09-17', kickoff: at('2026-09-18T00:15:00.000Z') }, // Thu 5:15pm AZ
  DET: { date: '2026-09-17', kickoff: at('2026-09-18T00:15:00.000Z') },
  KC: { date: '2026-09-20', kickoff: at('2026-09-21T00:20:00.000Z') }, // Sun night
  ATL: { date: '2026-09-20', kickoff: at('2026-09-20T17:00:00.000Z') }, // Sun early
  SF: { date: '2026-09-21', kickoff: at('2026-09-22T00:15:00.000Z') }, // Mon night
  NOTIME: { date: '2026-09-20', kickoff: null }, // feed gave no start time
  BYE: undefined,
};

console.log('\nmarkets lock at kickoff, not at midnight');
check(
  'a thursday market locks at thursday kickoff',
  lockTimeFor(['BUF'], WEEK, null).toISOString(),
  '2026-09-18T00:15:00.000Z',
);
check(
  'not at midnight that morning',
  lockTimeFor(['BUF'], WEEK, null).getTime() !== lockInstantFor('2026-09-17').getTime(),
  true,
);
// The bug, stated as a test: on Thursday afternoon the Thursday board is open.
const thursdayNoon = at('2026-09-17T19:00:00.000Z'); // 12pm AZ, five hours before kickoff
check('still open at noon on game day', lockTimeFor(['BUF'], WEEK, null) > thursdayNoon, true);
check(
  'the old rule would already have closed it',
  lockInstantFor('2026-09-17') < thursdayNoon,
  true,
);

console.log('\nthe earliest kickoff wins');
check(
  'an early sunday game beats a sunday night one',
  lockTimeFor(['KC', 'ATL'], WEEK, null).toISOString(),
  '2026-09-20T17:00:00.000Z',
);
check(
  'a thursday starter drags a sunday lineup earlier',
  lockTimeFor(['KC', 'ATL', 'BUF', 'SF'], WEEK, null).toISOString(),
  '2026-09-18T00:15:00.000Z',
);
check('order does not matter', lockTimeFor(['SF', 'BUF'], WEEK, null).toISOString(), '2026-09-18T00:15:00.000Z');
check(
  'duplicates do not change the answer',
  lockTimeFor(['BUF', 'BUF', 'BUF'], WEEK, null).toISOString(),
  '2026-09-18T00:15:00.000Z',
);
check('monday night locks monday night', lockTimeFor(['SF'], WEEK, null).toISOString(), '2026-09-22T00:15:00.000Z');

console.log('\nwhen the feed gives no kickoff');
// Falling back to midnight locks early, which costs a betting window. Locking
// late would let somebody bet a finished game, so early is the safe direction.
check(
  'falls back to midnight on the game day',
  lockTimeFor(['NOTIME'], WEEK, null).toISOString(),
  '2026-09-20T07:00:00.000Z',
);
check(
  'and a known kickoff still beats it when both are present',
  lockTimeFor(['NOTIME', 'BUF'], WEEK, null).toISOString(),
  '2026-09-18T00:15:00.000Z',
);

console.log('\nbyes and unknowns');
const fallback = at('2026-09-25T07:00:00.000Z');
check('team on bye is ignored', lockTimeFor(['ATL', 'BYE'], WEEK, fallback).toISOString(), '2026-09-20T17:00:00.000Z');
check('unknown team is ignored', lockTimeFor(['ATL', 'XXX'], WEEK, fallback).toISOString(), '2026-09-20T17:00:00.000Z');
check('all unknown falls back', lockTimeFor(['XXX'], WEEK, fallback), fallback);
check('empty falls back', lockTimeFor([], WEEK, fallback), fallback);

console.log('\nthe week as a whole');
check('the last kickoff is the monday nighter', latestKickoff(WEEK).toISOString(), '2026-09-22T00:15:00.000Z');
check('a game day is still readable for labels', gameDayFor(WEEK, 'BUF'), '2026-09-17');
check('and null for a team that is not playing', gameDayFor(WEEK, 'XXX'), null);

console.log('\nmidnight arizona, still the fallback');
// Arizona is UTC-7 year round, so local midnight is 07:00Z the same day. If it
// observed DST this would be 06:00Z in September; identical offsets are why
// this file is thirty lines and not a timezone library.
check('september', lockInstantFor('2026-09-20').toISOString(), '2026-09-20T07:00:00.000Z');
check('december (no DST shift)', lockInstantFor('2026-12-06').toISOString(), '2026-12-06T07:00:00.000Z');
check(
  'offset is constant across the season',
  lockInstantFor('2026-09-20').getUTCHours() === lockInstantFor('2026-12-06').getUTCHours(),
  true,
);

console.log('\nbetting window');
// The whole point: a Thursday market must not still be open on Saturday.
const thu = lockTimeFor(['BUF'], WEEK, null);
const sun = lockTimeFor(['ATL'], WEEK, null);
check('thursday market locks before sunday market', thu < sun, true);
check('with most of three days in between', Math.round((sun - thu) / 3600000), 65);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
