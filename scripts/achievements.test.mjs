/**
 * Exercises every achievement against a hand-built week whose correct answers
 * are known. Week 1 has no scores yet, so without this the scoring engine would
 * first run for real on Tuesday with nobody having checked the math.
 */
import { ACHIEVEMENTS, byId, inTheRunning } from './achievements.mjs';

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
  // `missedPoints` is what the lineup award reads now -- points left by players
  // who actually PLAYED. `benchPoints` is kept because other things display it,
  // and team 'b' deliberately has a big raw bench but a perfect lineup, which
  // is exactly the case the old award got wrong.
  { slug: 'a', points: 150, benchPoints: 10, missedPoints: 12, projected: 140, winStreak: 2 },
  { slug: 'b', points: 120, benchPoints: 40, missedPoints: 0, projected: 130, winStreak: 0 },
  { slug: 'c', points: 100, benchPoints: 40, missedPoints: 28, projected: 95, winStreak: 0 },
  { slug: 'd', points: 90, benchPoints: 25, missedPoints: 4, projected: 110, winStreak: 0 },
  { slug: 'e', points: 80, benchPoints: 5, missedPoints: 9, projected: 100, winStreak: 3 },
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
check('manager of the week missed the fewest startable points', run('manager-of-week', ctx), ['b']);
// The bug the rewrite fixed: 'b' has the BIGGEST raw bench (40) and still wins,
// because none of it could have been started. The old award would have given
// this to 'e' for having a thin bench.
check('a big bench does not lose it', byId['manager-of-week'].compute(ctx)[0].slug, 'b');

console.log('\npain achievements');
check('low score', run('low-score', ctx), ['e']);
check('and low score is now a consolation, not a fine', byId['low-score'].points > 0, true);
// 'worst-bench' was removed: it punished a bad start/sit call, and nothing in
// the list is negative any more.
check('no punishment awards remain', ACHIEVEMENTS.filter((a) => a.points < 0), []);
check('and the punishment award is gone', byId['worst-bench'], undefined);
check('beating your own projection pays', run('beat-projection', ctx), ['a', 'c']);
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
    { slug: 'a', points: 150, benchPoints: 10, missedPoints: 10, projected: 140, winStreak: 0 },
    { slug: 'b', points: 150, benchPoints: 10, missedPoints: 10, projected: 140, winStreak: 0 },
  ],
};
check('a tie awards everyone tied', run('top-score', tied), ['a', 'b']);
// A missing projection must not read as zero -- that would award everyone.
check(
  'no projection means no winner',
  run('beat-projection', { ...ctx, teams: teams.map((t) => ({ ...t, projected: null })) }),
  [],
);
check('empty starters yields no player award', run('top-player', { ...ctx, allStarters: [] }), []);
check('no position match yields no award', run('top-qb', { ...ctx, allStarters: allStarters.filter((p) => p.position !== 'QB') }), []);

console.log('\nnot started means not in the running');
{
  // Thursday night: a and d have played, everyone else is at zero.
  const live = {
    teams: [
      { slug: 'a', points: 30, missedPoints: 0, projected: 140 },
      { slug: 'd', points: 20, missedPoints: 0, projected: 110 },
      { slug: 'b', points: 0, missedPoints: 0, projected: 130 },
      { slug: 'c', points: 0, missedPoints: 0, projected: 95 },
    ],
    games: [
      { winnerSlug: 'a', loserSlug: 'd', winnerPoints: 30, loserPoints: 20, margin: 10, upset: false, loserName: 'D' },
      // b "beats" c 0-0 only because neither has started.
      { winnerSlug: 'b', loserSlug: 'c', winnerPoints: 0, loserPoints: 0, margin: 0, upset: false, loserName: 'C' },
    ],
    allStarters: [
      { slug: 'a', name: 'QB1', position: 'QB', points: 30, played: true },
      { slug: 'd', name: 'QB4', position: 'QB', points: 20, played: true },
      { slug: 'a', name: 'TE1', position: 'TE', points: 0, played: false },
      { slug: 'b', name: 'QB2', position: 'QB', points: 0, played: false },
      { slug: 'b', name: 'TE2', position: 'TE', points: 0, played: false },
      { slug: 'c', name: 'TE3', position: 'TE', points: 0, played: false },
    ],
    median: 10,
  };
  const r = inTheRunning(live);
  check('only started teams are candidates', r.teams.map((t) => t.slug), ['a', 'd']);
  check('a game with an unstarted side is not a game', r.games.map((g) => g.winnerSlug), ['a']);
  check('the median is of started teams', r.median, 25);
  check('an unstarted team is bottom of nothing', run('low-score', r), ['d']);
  check('no ugly win for a 0-0 "winner"', run('lucky-win', r), ['a']);
  check('no perfect lineup for a lineup nobody played', run('perfect-lineup', r), ['a', 'd']);
  check('no Best TE while no TE has played', run('top-te', r), []);
  check('Best QB among the QBs who have played', run('top-qb', r), ['a']);
  // A finished week is untouched: everyone has started.
  const done = { ...ctx, allStarters: ctx.allStarters.map((p) => ({ ...p, played: true })) };
  check('a finished week keeps every team', inTheRunning(done).teams.length, ctx.teams.length);
}

console.log('\npoint values');
check('lineup decision outranks raw high score', byId['manager-of-week'].points > byId['top-score'].points, true);
// Inverted deliberately. Points buy boosts now, so docking the manager already
// losing on the field would compound a bad season into a bad season with
// nothing to do about it. The 'pain' category pays consolation instead.
check('every pain award pays something', ACHIEVEMENTS.filter((a) => a.category === 'pain' && a.points <= 0).map((a) => a.id), []);
// The floor that matters: someone who loses badly still collects. A team that
// lost, scored the league low, kept it close and beat the spread earns four.
check(
  'a losing team can still earn from four awards',
  ['low-score', 'unluckiest', 'close-loss', 'beat-spread'].every((id) => byId[id]?.points > 0),
  true,
);
check('every achievement has a unique id', new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
