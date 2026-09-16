/**
 * Tests must never reach a real phone.
 *
 * Suites run against the same database with real bettor slugs, which is what
 * keeps them honest -- but notify() takes a slug, not a season, so a sentinel
 * fill sent "Bought 2 x p1 at 12" to Chris's lock screen three times in one
 * afternoon on 2026-09-16. The guard lives in lib/push.js so it cannot be
 * forgotten by the twenty-two suites that can reach a notification.
 */
import { notify, notifyMany, notifyAll } from '../lib/push.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` + (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
  if (!match) failed++;
};

console.log('\nno test run can push to a real device');
ok('notify sends nothing', await notify('chris-nicholson', { title: 'x', body: 'y' }), 0);
ok('notifyMany sends nothing', await notifyMany(['chris-nicholson', 'devin-nicholson'], { title: 'x', body: 'y' }), 0);
ok('notifyAll sends nothing', await notifyAll({ title: 'x', body: 'y' }), 0);

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
