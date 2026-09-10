/**
 * Fits the scoring standard deviation from this league's own history.
 *
 * The pricing model needs one number: how much a weekly score varies. It was a
 * guess of 25 -- reasonable for PPR generally, but this league has 18 seasons
 * of its own results, so there is no reason to guess.
 *
 * Uses the margin between paired teams rather than raw scores. The margin is
 * what the model actually cares about, and it cancels week-to-week league-wide
 * effects (a high-scoring week lifts both sides), leaving the variance that
 * genuinely separates two lineups.
 *
 *   per-team sd = sd(margin) / sqrt(2)
 *
 * Run: node scripts/fit-sd.mjs [seasons]
 */
import { readFileSync } from 'node:fs';

const lookback = Number(process.argv[2]) || 10;
const league = JSON.parse(readFileSync('data/league.json', 'utf8'));

const games = (league.games ?? []).filter(
  (g) => g.homePoints != null && g.awayPoints != null && !g.isPlayoff,
);
if (!games.length) {
  console.error('No completed regular-season games in data/league.json.');
  process.exit(1);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const stdev = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

const seasons = [...new Set(games.map((g) => g.season))].sort();
const recent = seasons.slice(-lookback);
const sample = games.filter((g) => recent.includes(g.season));

const margins = sample.map((g) => g.homePoints - g.awayPoints);
const scores = sample.flatMap((g) => [g.homePoints, g.awayPoints]);

const marginSd = stdev(margins);
const perTeamSd = marginSd / Math.SQRT2;

console.log(`Seasons ${recent[0]}-${recent[recent.length - 1]} (${sample.length} games)\n`);
console.log(`  mean team score      ${mean(scores).toFixed(1)}`);
console.log(`  team score sd        ${stdev(scores).toFixed(2)}`);
console.log(`  margin sd            ${marginSd.toFixed(2)}`);
console.log(`  mean margin          ${mean(margins).toFixed(2)}  (should be ~0)`);
console.log(`\n  fitted per-team sd   ${perTeamSd.toFixed(2)}`);

// Sanity check: how often does the model's own prediction hold up? A margin of
// one sd should be a win about 76% of the time if the normal assumption is
// sound.
const oneSd = sample.filter((g) => Math.abs(g.homePoints - g.awayPoints) >= marginSd);
console.log(
  `\n  games decided by 1+ margin-sd: ${oneSd.length} of ${sample.length}` +
    ` (${((oneSd.length / sample.length) * 100).toFixed(1)}%, normal predicts 31.7%)`,
);
