/**
 * Telling a broken verifier apart from a verifier that found something.
 *
 * On 2026-09-23 the headless CLI's OAuth session expired mid-run. The two
 * verification agents could not reach Sleeper, the database or the history
 * file: one marked all 44 claims UNVERIFIABLE and returned pass=false, the
 * other returned nothing parseable. Publication was blocked, which was the
 * right outcome -- but the report read "failed without naming a claim", which
 * is exactly how a working verifier looks when it disagrees about something it
 * cannot articulate.
 *
 * That ambiguity is the actual hazard. The habit on a blocked run is to skim
 * the problems, recognise the familiar false positives and publish anyway. If
 * a verifier that checked NOTHING looks the same as one that checked
 * everything and objected, that habit eventually waves a real error through to
 * the whole league.
 *
 * So the two are now labelled differently, and both still block. Pure: decide()
 * takes verdicts and returns a decision, no database and no network.
 */
import { decide } from '../lib/writeup-verify.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

const claims = (n, verdict) => Array.from({ length: n }, (_, i) => ({ claim: `c${i}`, verdict }));
const clean = { pass: true, claims: claims(3, 'VERIFIED') };
const blind = { pass: false, claims: claims(44, 'UNVERIFIABLE') };
const found = {
  pass: false,
  claims: [{ claim: 'Kevin scored 999', verdict: 'WRONG', correction: '171.08' }, ...claims(2, 'VERIFIED')],
};

console.log('\na verifier that could not check anything');
{
  const d = decide({ agentVerdicts: [blind, null] });
  ok('publication is blocked', d.publish, false);
  ok('both agents are reported', d.problems.length, 2);
  ok('and both are marked broken', d.problems.every((p) => p.broken === true), true);
  ok('the message says so in words', /broken verifier/.test(d.problems[0].why), true);
  ok('and points at the likely cause', /authenticated/.test(d.problems[0].why), true);
}

console.log('\na verifier that checked and objected');
{
  const d = decide({ agentVerdicts: [found, clean] });
  ok('publication is blocked', d.publish, false);
  ok('the failing claim is named', d.problems[0].why.includes('Kevin scored 999'), true);
  ok('it is NOT marked broken', d.problems[0].broken, undefined);
  ok('the correction rides along', d.problems[0].correction, '171.08');
}

console.log('\nthe two are distinguishable, which is the whole point');
{
  const broken = decide({ agentVerdicts: [blind, null] }).problems.filter((p) => p.broken);
  const real = decide({ agentVerdicts: [found, clean] }).problems.filter((p) => p.broken);
  ok('broken run reports broken problems', broken.length, 2);
  ok('real finding reports none', real.length, 0);
}

console.log('\na mixed verdict is still a real finding');
{
  // Some claims unverifiable is normal -- an opinion or a prediction cannot be
  // checked. It is only a broken verifier when NOTHING could be checked.
  const mixed = {
    pass: false,
    claims: [
      { claim: 'bad', verdict: 'WRONG' },
      ...claims(20, 'UNVERIFIABLE'),
      { claim: 'fine', verdict: 'VERIFIED' },
    ],
  };
  const d = decide({ agentVerdicts: [mixed, clean] });
  ok('not treated as broken', d.problems.some((p) => p.broken), false);
  ok('the wrong claim is named', d.problems[0].why.includes('bad'), true);
}

console.log('\nclean runs still publish');
{
  const d = decide({ agentVerdicts: [clean, clean] });
  ok('two clean verdicts publish', d.publish, true);
  ok('with nothing to report', d.problems.length, 0);
}

console.log('\nand a code-gate error still blocks on its own');
{
  const d = decide({
    numbers: [{ severity: 'error', number: 1, why: 'invented' }],
    agentVerdicts: [clean, clean],
  });
  ok('blocked by the number gate alone', d.publish, false);
}

console.log('\none verifier is never enough');
{
  const d = decide({ agentVerdicts: [clean] });
  ok('a single verdict is refused', d.publish, false);
  ok('and says why', /two independent/.test(d.problems[0].why), true);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
