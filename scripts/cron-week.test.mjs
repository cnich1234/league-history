/**
 * The prior-week guard.
 *
 * Week 1 paid out trophies and the allowance against a week still being
 * played: `Math.max(1, week - 1)` floors to 1, so during week 1 the cron
 * treated week 1 as finished. Scores move all through Sunday, so anything
 * keyed to a live week is provisional.
 *
 * "No completed week yet" is not week 1, it is nothing -- the guard returns
 * null and every week-dependent step skips.
 */
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (name, cond) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failed += 1;
};

// The guard, as the cron computes it.
const priorWeek = (week) => (week > 1 ? week - 1 : null);

console.log('\nprior-week guard');
ok('week 1 has no completed week', priorWeek(1) === null);
ok('week 2 points at week 1', priorWeek(2) === 1);
ok('week 3 points at week 2', priorWeek(3) === 2);
ok('week 14 points at week 13', priorWeek(14) === 13);

console.log('\nnever pays out on a live week');
for (const w of [1, 2, 3, 8, 14, 18]) {
  const p = priorWeek(w);
  ok(`week ${w}: prior is null or strictly earlier`, p === null || p < w);
}

console.log('\nthe old floor was wrong exactly at week 1');
const oldFloor = (week) => Math.max(1, week - 1);
ok('old code treated live week 1 as finished', oldFloor(1) === 1);
ok('guard does not', priorWeek(1) !== 1);
ok('old and new agree from week 2 on', [2, 3, 8, 14, 18].every((w) => oldFloor(w) === priorWeek(w)));

// The regression that actually bit: a floor left in the cron would pay out on
// a live week again. Checked against the source so it cannot creep back.
console.log('\nsource has no collapsing floor');
const src = readFileSync(new URL('../app/api/cron/route.js', import.meta.url), 'utf8');
const code = src
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');
ok('no Math.max(1, week - 1) in cron code', !/Math\.max\(\s*1\s*,\s*week\s*-\s*1\s*\)/.test(code));
ok('guard is defined', /const priorWeek = week > 1 \? week - 1 : null/.test(code));

// Every week-dependent step must refuse to run when nothing has finished.
const guarded = (code.match(/if \(priorWeek == null\) throw new Error\('no completed week yet'\)/g) ?? []).length;
ok(`all five week-dependent steps guarded (found ${guarded})`, guarded === 5);

// The allowance pays the FINISHED week, not the live one.
ok(
  'allowance uses priorWeek, not week',
  /grantWeeklyAllowance\(season, priorWeek\)/.test(code) &&
    !/grantWeeklyAllowance\(season, week\)/.test(code),
);

// Current-week work must NOT sit behind the guard. Culling a bounty whose bet
// already settled asks whether a BET is done, not whether a WEEK is -- guarding
// it would hold people's points on dead bounties for the whole of week 1.
console.log('\ncurrent-week work still runs during a live week');
const blocks = code.split(/\n    try \{/).slice(1).map((b) => b.split(/\n    \} catch/)[0]);
const guardedBlocks = blocks.filter((b) => /priorWeek == null/.test(b));
const usesCurrentWeek = (b) =>
  [...b.matchAll(/await (\w+)\(([^)]*)\)/g)]
    .map((m) => `${m[1]}(${m[2]})`)
    .filter((c) => /\bweek\b/.test(c) && !/priorWeek|prior\b/.test(c));
const offenders = guardedBlocks.flatMap(usesCurrentWeek);
ok(`no guarded step operates on the live week (${offenders.length} found)`, offenders.length === 0);
ok('dead-bounty cull is not guarded', blocks.some((b) => /cullDeadBountyBets/.test(b) && !/priorWeek == null/.test(b)));
ok('salaries are not guarded', blocks.some((b) => /buildSalaries/.test(b) && !/priorWeek == null/.test(b)));

// The MONEY allowance is ammunition for the week opening, so it is paid for
// the CURRENT week and never gated on a finished one. It was paid by nothing
// at all: weeks 1 and 2 had rows only because they were inserted by hand.
console.log('\nmoney allowance');
const moneyBlock = blocks.find((b) => /grantMoney\(/.test(b));
ok('cron grants the money allowance', Boolean(moneyBlock));
ok('for the current week, not priorWeek', /grantMoney\(week, WEEKLY_ALLOWANCE_CENTS\)/.test(moneyBlock ?? ''));
ok('not behind the completed-week guard', !/priorWeek == null/.test(moneyBlock ?? ''));
ok('logged even when it pays nobody', /money allowance to \$\{funded\.length\}/.test(moneyBlock ?? ''));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
