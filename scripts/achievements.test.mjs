/**
 * Exercises every achievement against a hand-built week whose correct answers
 * are known. Week 1 has no scores yet, so without this the scoring engine would
 * first run for real on Tuesday with nobody having checked the math.
 */
import { ACHIEVEMENTS, byId } from './achievements.mjs';

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
    failed++;
  }
};

const run = (id, ctx) => byId[id].compute(ctx).map((r) => r.slug).sort();

// Five teams. Scores chosen so the median sits between b and c.
const teams = [
  { slug: 'a', points: 150, benchPoints: 10, winStreak: 2, worstBenchMistake: { benched: 'X', benchedPoints: 20, started: 'Y', startedPoints: 5, swing: 15 } },
  { slug: 'b', points: 120, benchPoints: 3, winStreak: 0, worstBenchMistake: null },
  { slug: 'c', points: 100, benchPoints: 40, winStreak: 0, worstBenchMistake: { benched: 'Z', benchedPoints: 30, started: 'W', startedPoints: 2, swing: 28 } },
  { slug: 'd', points: 90, benchPoints: 25, winStreak: 0, worstBenchMistake: null },
  { slug: 'e', points: 80, benchPoints: 5, winStreak: 3, worstBenchMistake: null },
];

const games = [
  { winnerSlug: 'a', loserSlug: 'd', winnerPoints: 150, loserPoints: 90, margin: 60, upset: false, loserName: 'D' },
  { winnerSlug: 'e', loserSlug: 'c', winnerPoints: 80, loserPoints: 100, margin: -20, upset: true, loserName: 'C' },
  { winnerSlug: 'b', loserSlug: 'x', winnerPoints: 120, loserPoints: 95, margin: 25, upset: false, loserName: 'X' },
];

const allStarters = [
  { slug: 'a', name: 'QB1', position: 'QB', points: 30 },
  { slug: 'b', name: 'QB2', position: 'QB', points: 25 },
  { slug: 'c', name: 'RB1', position: 'RB', points: 40 },
  { slug: 'd', name: 'WR1', position: 'WR', points: 35 },
  { slug: 'e', name: 'TE1', position: 'TE', points: 12 },
];

const ctx = { teams, games, allStarters, median: 100 };

console.log('\ncore achievements');
check('high score is the top scorer', run('top-score', ctx), ['a']);
// Strictly above the median -- c scored exactly 100 and must not qualify.
check('beat-the-median excludes an exact median score', run('above-median', ctx), ['a', 'b']);
check('biggest margin', run('biggest-margin', ctx), ['a']);
check('player of the week is highest scorer at any position', run('top-player', ctx), ['c']);
check('manager of the week left fewest bench points', run('manager-of-week', ctx), ['b']);

console.log('\npain achievements');
check('low score', run('low-score', ctx), ['e']);
check('worst bench call is the biggest swing', run('worst-bench', ctx), ['c']);
check('unluckiest is the highest-scoring loser', run('unluckiest', ctx), ['c']);

console.log('\nbonus achievements');
check('giant killer flagged on upset', run('giant-killer', ctx), ['e']);
check('hot streak needs 3+', run('hot-streak', ctx), ['e']);

console.log('\nposition awards');
check('best QB', run('top-qb', ctx), ['a']);
check('best RB', run('top-rb', ctx), ['c']);
check('best WR', run('top-wr', ctx), ['d']);
check('best TE', run('top-te', ctx), ['e']);

console.log('\nties and edge cases');
const tied = {
  ...ctx,
  teams: [
    { slug: 'a', points: 150, benchPoints: 10, winStreak: 0, worstBenchMistake: null },
    { slug: 'b', points: 150, benchPoints: 10, winStreak: 0, worstBenchMistake: null },
  ],
};
check('a tie awards everyone tied', run('top-score', tied), ['a', 'b']);
check('no bench mistakes yields no award', run('worst-bench', { ...ctx, teams: teams.map((t) => ({ ...t, worstBenchMistake: null })) }), []);
check('empty starters yields no player award', run('top-player', { ...ctx, allStarters: [] }), []);
check('no position match yields no award', run('top-qb', { ...ctx, allStarters: allStarters.filter((p) => p.position !== 'QB') }), []);

console.log('\npoint values');
check('lineup decision outranks raw high score', byId['manager-of-week'].points > byId['top-score'].points, true);
check('pain awards are negative', ACHIEVEMENTS.filter((a) => a.category === 'pain' && a.points > 0).map((a) => a.id), ['unluckiest']);
check('every achievement has a unique id', new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
