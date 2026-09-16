/**
 * The publication gates, tested against the errors that actually happened.
 *
 * Every case below is a real mistake from the week 2 preview draft on
 * 2026-09-16, not an invented one. Two agents and a manual pass found six; the
 * point of this suite is that the ones a machine can catch are caught before
 * anyone is asked to read the thing.
 *
 * The one that matters most is attribution. That draft had every number right
 * and still implied a manager's Market holdings were his own underperforming
 * lineup, because nothing in the context said who actually rostered the player.
 * If this suite ever goes quiet on that case, the gate is broken.
 */
import { checkAttribution, checkNumbers, checkPrivacy, decide } from '../lib/writeup-verify.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

/** A stand-in for buildWriteupContext, with the week 1 shape and real values. */
const CONTEXT = {
  playerOwnership: {
    '7564': { name: "Ja'Marr Chase", rosteredBy: 'Austin', started: true, points: 3.2 },
    '12517': { name: 'Colston Loveland', rosteredBy: 'Chad', started: true, points: 0 },
    '6770': { name: 'Joe Burrow', rosteredBy: 'Kevin', started: true, points: 16.16 },
    '4034': { name: 'Christian McCaffrey', rosteredBy: 'Brandon', started: true, points: 12.4 },
  },
  standings: [
    { manager: 'Kevin', pointsFor: 191.66, pointsAgainst: 147.4 },
    { manager: 'Brandon', pointsFor: 147.4, pointsAgainst: 191.66 },
    { manager: 'Devin', pointsFor: 135.4, pointsAgainst: 130.02 },
    { manager: 'Chris N', pointsFor: 155.42, pointsAgainst: 119.54 },
    { manager: 'Chad', pointsFor: 139.16, pointsAgainst: 138.84 },
    { manager: 'Austin', pointsFor: 119.54, pointsAgainst: 155.42 },
    { manager: 'Mike R', pointsFor: 138.84, pointsAgainst: 139.16 },
  ],
  results: [
    {
      margin: 44.26,
      winner: 'Kevin',
      loser: 'Brandon',
      home: { manager: 'Kevin', points: 191.66, starters: [{ name: 'Justin Jefferson', points: 31.2 }], bench: [] },
      away: { manager: 'Brandon', points: 147.4, starters: [], bench: [] },
    },
    {
      margin: 0.32,
      winner: 'Chad',
      loser: 'Mike R',
      home: { manager: 'Chad', points: 139.16, starters: [], bench: [{ name: 'Jaxson Dart', points: 32.6 }] },
      away: { manager: 'Mike R', points: 138.84, starters: [], bench: [] },
    },
  ],
  preview: [
    { home: { manager: 'Chris N', projected: 141.8 }, away: { manager: 'Chad', projected: 136.9 } },
  ],
  history: {
    'Chris N vs Chad': {
      biggestBlowout: { season: 2014, week: 9, homePoints: 93, awayPoints: 169, margin: 76 },
      mostRecent: { season: 2025, week: 12, homePoints: 123.2, awayPoints: 130 },
      careers: {},
    },
  },
};

console.log('\nattribution: the error that had every number right');
{
  // The exact frame the first draft used: Kevin owns SHARES in Chase; Austin
  // rosters him. Written as a possessive it becomes a false claim.
  const bad = "Kevin's Ja'Marr Chase caught two passes for 3.2 points, which is not what you want.";
  const problems = checkAttribution(bad, CONTEXT);
  ok('a wrongly attributed player is caught', problems.length, 1);
  ok('and names the real owner', problems[0]?.actuallyRosteredBy, 'Austin');
  ok('and is blocking', problems[0]?.severity, 'error');
}
{
  // The corrected phrasing: the shares are Kevin's, the player is Austin's.
  const good =
    "Kevin bought ten shares of Ja'Marr Chase. Chase actually plays for Austin, who started him for 3.2 points.";
  ok('the corrected phrasing passes', checkAttribution(good, CONTEXT).length, 0);
}
{
  const right = "Chad's Colston Loveland scored exactly 0.0, which is its own achievement.";
  ok('a correctly attributed player passes', checkAttribution(right, CONTEXT).length, 0);
}

console.log('\nnumbers: invented figures do not publish');
{
  const bad = 'Kevin put up 191.66 and Brandon managed 147.40, a margin of 52.18.';
  const problems = checkNumbers(bad, CONTEXT);
  ok('a wrong margin is caught', problems.some((p) => p.number === 52.18 && p.severity === 'error'), true);
}
{
  const good = 'Kevin put up 191.66 and Brandon managed 147.40, a margin of 44.26.';
  ok('the right margin passes', checkNumbers(good, CONTEXT).filter((p) => p.severity === 'error').length, 0);
}
{
  const hist = 'He owns the biggest blowout in the series, 169 to 93 back in 2014.';
  ok('historical scores are known', checkNumbers(hist, CONTEXT).filter((p) => p.severity === 'error').length, 0);
}
{
  // Projections move between writing and checking. That is drift, not invention.
  const stale = 'The model splits it 141.8 to 137.5, a narrow edge.';
  const problems = checkNumbers(stale, CONTEXT);
  ok('a drifted projection warns rather than blocks', problems.every((p) => p.severity === 'warning'), true);
  ok('and says what the feed now reads', problems.some((p) => p.why.includes('136.9')), true);
}

console.log('\nprivacy: nobody else\'s portfolio, nobody else\'s points');
{
  // The exact paragraph that shipped in the week 2 preview on 2026-09-16 and
  // had to be taken down. Holdings are private for the same reason bets are
  // hidden until a market locks: visible positions get copied, and then the
  // whole league owns the same four players and calls it strategy.
  const leak = 'Three people are trading. Kevin has 22 shares, Devin has 15, and Chris N has 10.';
  ok('a named share count is blocked', checkPrivacy(leak, CONTEXT).length > 0, true);
  ok('and it is blocking', checkPrivacy(leak, CONTEXT)[0]?.severity, 'error');
}
ok(
  'a points balance is blocked',
  checkPrivacy('Kevin now has 4 points to his name, the lowest in the league.', CONTEXT).length > 0,
  true,
);
ok(
  'points spent are blocked',
  checkPrivacy('Kevin spent 46 points on the stock market.', CONTEXT).length > 0,
  true,
);
ok(
  'the word portfolio against a name is blocked',
  checkPrivacy("Kevin's portfolio looks like a cry for help.", CONTEXT).length > 0,
  true,
);
ok(
  'an anonymous total is allowed',
  checkPrivacy('Three people are trading and twenty-five shares sit in one receiver.', CONTEXT).length,
  0,
);
ok(
  'ordinary trash talk is untouched',
  checkPrivacy('Kevin put up 191.66 and has the best roster in the league.', CONTEXT).length,
  0,
);

console.log('\nthe decision: a missing check is never a pass');
{
  const clean = { attribution: [], numbers: [] };
  ok('no agent verdicts at all blocks', decide({ ...clean, agentVerdicts: [] }).publish, false);
  ok('one verdict blocks', decide({ ...clean, agentVerdicts: [{ pass: true, claims: [] }] }).publish, false);
  ok(
    'two clean verdicts publish',
    decide({ ...clean, agentVerdicts: [{ pass: true, claims: [] }, { pass: true, claims: [] }] }).publish,
    true,
  );
  ok(
    'a malformed verdict blocks',
    decide({ ...clean, agentVerdicts: [{ pass: true, claims: [] }, { somethingElse: true }] }).publish,
    false,
  );
  ok(
    'a single WRONG claim blocks',
    decide({
      ...clean,
      agentVerdicts: [
        { pass: true, claims: [] },
        { pass: false, claims: [{ claim: 'beaten seven other teams', verdict: 'WRONG', correction: 'six' }] },
      ],
    }).publish,
    false,
  );
  ok(
    'an UNVERIFIABLE claim alone does not block',
    decide({
      ...clean,
      agentVerdicts: [
        { pass: true, claims: [{ claim: 'he will win by forty', verdict: 'UNVERIFIABLE' }] },
        { pass: true, claims: [] },
      ],
    }).publish,
    true,
  );
  ok(
    'a code-gate error blocks even with two clean verdicts',
    decide({
      attribution: [{ severity: 'error', why: 'wrong owner' }],
      numbers: [],
      agentVerdicts: [{ pass: true, claims: [] }, { pass: true, claims: [] }],
    }).publish,
    false,
  );
  ok(
    'a privacy leak blocks even with two clean verdicts',
    decide({
      attribution: [],
      numbers: [],
      privacy: [{ severity: 'error', why: 'named share count' }],
      agentVerdicts: [{ pass: true, claims: [] }, { pass: true, claims: [] }],
    }).publish,
    false,
  );
  ok(
    'a warning alone does not block',
    decide({
      attribution: [],
      numbers: [{ severity: 'warning', why: 'stale projection' }],
      agentVerdicts: [{ pass: true, claims: [] }, { pass: true, claims: [] }],
    }).publish,
    true,
  );
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
