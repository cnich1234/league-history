/**
 * Lock timing. The rule is simple -- midnight Arizona on the morning of the
 * game -- but the consequence of getting it wrong is someone betting a game
 * that has already been played, so it is worth pinning down.
 */
import { lockInstantFor, lockTimeFor } from '../lib/schedule.js';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`); failed++; }
};

console.log('\nmidnight arizona');
// Arizona is UTC-7 year round, so local midnight is 07:00Z the same day.
check('september game', lockInstantFor('2026-09-20').toISOString(), '2026-09-20T07:00:00.000Z');
check('december game (no DST shift)', lockInstantFor('2026-12-06').toISOString(), '2026-12-06T07:00:00.000Z');
check('january game', lockInstantFor('2027-01-03').toISOString(), '2027-01-03T07:00:00.000Z');
// If Arizona observed DST this would be 06:00Z in September and 07:00Z in
// December. Identical offsets are the point.
check(
  'offset is constant across the season',
  lockInstantFor('2026-09-20').getUTCHours() === lockInstantFor('2026-12-06').getUTCHours(),
  true,
);

console.log('\nearliest game day wins');
const dates = { KC: '2026-09-20', BUF: '2026-09-17', SF: '2026-09-21', BYE: undefined };
check('single team locks on its own day', lockTimeFor(['KC'], dates, null).toISOString(), '2026-09-20T07:00:00.000Z');
check('mixed days lock on the earliest', lockTimeFor(['KC', 'BUF'], dates, null).toISOString(), '2026-09-17T07:00:00.000Z');
check('order does not matter', lockTimeFor(['BUF', 'KC'], dates, null).toISOString(), '2026-09-17T07:00:00.000Z');
check('monday game locks monday', lockTimeFor(['SF'], dates, null).toISOString(), '2026-09-21T07:00:00.000Z');
check(
  'a thursday starter drags a sunday lineup earlier',
  lockTimeFor(['KC', 'KC', 'BUF', 'SF'], dates, null).toISOString(),
  '2026-09-17T07:00:00.000Z',
);

console.log('\nbyes and unknowns');
const fallback = new Date('2026-09-25T07:00:00.000Z');
check('team on bye is ignored', lockTimeFor(['KC', 'BYE'], dates, fallback).toISOString(), '2026-09-20T07:00:00.000Z');
check('unknown team is ignored', lockTimeFor(['KC', 'XXX'], dates, fallback).toISOString(), '2026-09-20T07:00:00.000Z');
check('all unknown falls back', lockTimeFor(['XXX'], dates, fallback), fallback);
check('empty falls back', lockTimeFor([], dates, fallback), fallback);
check('duplicates do not change the answer', lockTimeFor(['BUF', 'BUF', 'BUF'], dates, null).toISOString(), '2026-09-17T07:00:00.000Z');

console.log('\nbetting window');
// The whole point: a Thursday market must not still be open on Saturday.
const thu = lockTimeFor(['BUF'], dates, null);
const sun = lockTimeFor(['KC'], dates, null);
check('thursday market locks before sunday market', thu < sun, true);
check('three clear days between them', Math.round((sun - thu) / 86400000), 3);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
