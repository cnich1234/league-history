/**
 * Monte Carlo: how many achievement points does a manager actually earn?
 *
 * Simulates whole seasons of this 10-team league, builds the exact `week`
 * object that lib/weekly.js + scripts/build-weekly.mjs pass to each
 * achievement's compute(), and runs the real ACHIEVEMENTS array against it.
 * Nothing here is hand-tuned to produce a nice answer -- the only inputs are
 * the scoring distribution (LEAGUE_SD = 28, fitted from 725 real games) and
 * per-position means.
 *
 * Run: node scripts/sim-points.mjs [seasons]
 */

import { ACHIEVEMENTS } from './achievements.mjs';

const SEASONS = Number(process.argv[2]) || 4000;
const TEAMS = 10;
const WEEKS = 14;
const TEAM_MEAN = 120;
const TEAM_SD = 28; // LEAGUE_SD from lib/odds.js

// Starting lineup: 1 QB, 2 RB, 3 WR, 1 TE, 1 K, 1 DEF = 9.
const LINEUP = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'];
// Bench: 5 players, drawn from the skill positions that matter for awards
// plus the odd kicker/defence, same distributions.
const BENCH = ['QB', 'RB', 'RB', 'WR', 'WR'];
const POS_MEAN = { QB: 18, RB: 11, WR: 10, TE: 8, K: 8, DEF: 8 };
const POS_SD_FRAC = 0.4;

const SLUGS = Array.from({ length: TEAMS }, (_, i) => `mgr${i + 1}`);

// ---------- rng ----------
// Seeded so a rerun reproduces the same numbers.
let seed = 0x9e3779b9;
function rand() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
let spare = null;
function normal(mean, sd) {
  if (spare !== null) { const v = spare; spare = null; return mean + sd * v; }
  let u = 0, v = 0, s = 0;
  do {
    u = rand() * 2 - 1;
    v = rand() * 2 - 1;
    s = u * u + v * v;
  } while (s === 0 || s >= 1);
  const mul = Math.sqrt((-2 * Math.log(s)) / s);
  spare = v * mul;
  return mean + sd * u * mul;
}
const round2 = (n) => +n.toFixed(2);

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pct(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * One roster's players for a week.
 *
 * Per-player draws are scaled so the 9 starters sum to a team total drawn from
 * N(120, 28). Without the rescale the starters would sum to a much tighter
 * distribution than the league actually shows (sum of 9 independent normals has
 * sd ~ 14, not 28), and every margin-based award would be wrong.
 */
function drawRoster() {
  const draw = (pos) => ({
    position: pos,
    points: round2(Math.max(0, normal(POS_MEAN[pos], POS_MEAN[pos] * POS_SD_FRAC))),
  });
  const starters = LINEUP.map(draw);
  const bench = BENCH.map(draw);

  const raw = starters.reduce((a, p) => a + p.points, 0);
  const target = Math.max(0, normal(TEAM_MEAN, TEAM_SD));
  const scale = raw > 0 ? target / raw : 0;
  for (const p of starters) p.points = round2(p.points * scale);
  // Bench shares the same week-level luck, so a team that blew up had good
  // players on the bench too. Anything else makes bench awards degenerate.
  for (const p of bench) p.points = round2(p.points * scale);

  return { starters, bench };
}

/** Same-position comparison, identical logic to scripts/build-weekly.mjs. */
function worstBenchMistake(starters, bench) {
  let worst = null;
  for (const b of bench) {
    const swappable = starters.filter((s) => s.position === b.position);
    const weakest = [...swappable].sort((x, y) => x.points - y.points)[0];
    if (weakest && b.points > weakest.points) {
      const swing = round2(b.points - weakest.points);
      if (!worst || swing > worst.swing) {
        worst = {
          benched: b.name, benchedPoints: b.points,
          started: weakest.name, startedPoints: weakest.points, swing,
        };
      }
    }
  }
  return worst;
}

function simulateSeason(errors) {
  const prior = Object.fromEntries(SLUGS.map((s) => [s, { w: 0, l: 0, streak: 0 }]));
  const seasonPoints = Object.fromEntries(SLUGS.map((s) => [s, 0]));
  const wins = {}; // achievement id -> count of (manager, week) awards

  for (let week = 1; week <= WEEKS; week++) {
    const teams = [];
    const allStarters = [];

    for (const slug of SLUGS) {
      const { starters, bench } = drawRoster();
      starters.forEach((p, i) => { p.name = `${slug}-S${i}-${p.position}`; });
      bench.forEach((p, i) => { p.name = `${slug}-B${i}-${p.position}`; });
      for (const s of starters) allStarters.push({ ...s, slug });

      const pr = prior[slug];
      teams.push({
        slug,
        name: slug,
        team: slug,
        points: round2(starters.reduce((a, p) => a + p.points, 0)),
        benchPoints: round2(bench.reduce((a, p) => a + p.points, 0)),
        worstBenchMistake: worstBenchMistake(starters, bench),
        recordBefore: `${pr.w}-${pr.l}`,
        winPctBefore: pr.w + pr.l ? pr.w / (pr.w + pr.l) : 0,
        winStreak: Math.max(0, pr.streak),
      });
    }

    // Random pairing each week: 5 games, everyone plays.
    const order = [...teams];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const games = [];
    for (let i = 0; i < order.length; i += 2) {
      const [win, lose] = [order[i], order[i + 1]].sort((a, b) => b.points - a.points);
      games.push({
        winnerSlug: win.slug, winnerName: win.team, winnerPoints: win.points,
        loserSlug: lose.slug, loserName: lose.team, loserPoints: lose.points,
        loserRecordBefore: lose.recordBefore,
        margin: round2(win.points - lose.points),
        upset: lose.winPctBefore > win.winPctBefore,
      });
    }

    const w = { teams, games, allStarters, median: median(teams.map((t) => t.points)) };

    // build-weekly.mjs folds THIS week's result into winStreak before running
    // compute(), so three-in-a-row includes the week you are being awarded for.
    for (const t of teams) {
      const won = games.some((g) => g.winnerSlug === t.slug);
      t.winStreak = won ? t.winStreak + 1 : 0;
    }

    for (const a of ACHIEVEMENTS) {
      let winners;
      try {
        winners = a.compute(w);
      } catch (e) {
        errors[a.id] = (errors[a.id] ?? 0) + 1;
        if (!errors[`${a.id}:msg`]) errors[`${a.id}:msg`] = e.message;
        continue;
      }
      if (!Array.isArray(winners)) {
        errors[`${a.id}:nonarray`] = (errors[`${a.id}:nonarray`] ?? 0) + 1;
        continue;
      }
      wins[a.id] = (wins[a.id] ?? 0) + winners.length;
      for (const win of winners) {
        if (!(win.slug in seasonPoints)) {
          errors[`${a.id}:badslug`] = (errors[`${a.id}:badslug`] ?? 0) + 1;
          continue;
        }
        seasonPoints[win.slug] += a.points;
      }
    }

    // Roll records forward for next week.
    for (const g of games) {
      const win = prior[g.winnerSlug], lose = prior[g.loserSlug];
      win.w++; win.streak = win.streak >= 0 ? win.streak + 1 : 1;
      lose.l++; lose.streak = lose.streak <= 0 ? lose.streak - 1 : -1;
    }
  }

  return { seasonPoints, wins };
}

// ---------- run ----------
const errors = {};
const allTotals = [];
const gaps = [];
const winCounts = {};
let medianPointsTotal = 0;
let grandTotal = 0;

for (let s = 0; s < SEASONS; s++) {
  const { seasonPoints, wins } = simulateSeason(errors);
  const vals = SLUGS.map((slug) => seasonPoints[slug]);
  for (const v of vals) { allTotals.push(v); grandTotal += v; }
  gaps.push(Math.max(...vals) - Math.min(...vals));
  for (const [id, n] of Object.entries(wins)) winCounts[id] = (winCounts[id] ?? 0) + n;
}

allTotals.sort((a, b) => a - b);
const managerSeasons = SEASONS * TEAMS;
const mean = grandTotal / managerSeasons;

const byId = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
const aboveMedianPts =
  ((winCounts['above-median'] ?? 0) * byId['above-median'].points) / managerSeasons;

console.log(`\nSeasons simulated: ${SEASONS}  (${managerSeasons} manager-seasons, ${WEEKS} weeks, ${TEAMS} teams)`);
console.log(`Team score model: N(${TEAM_MEAN}, ${TEAM_SD})\n`);

console.log('=== SEASON TOTALS PER MANAGER ===');
console.log(`mean            ${mean.toFixed(2)}`);
console.log(`median          ${pct(allTotals, 0.5).toFixed(2)}`);
console.log(`p10             ${pct(allTotals, 0.10).toFixed(2)}`);
console.log(`p25             ${pct(allTotals, 0.25).toFixed(2)}`);
console.log(`p75             ${pct(allTotals, 0.75).toFixed(2)}`);
console.log(`p90             ${pct(allTotals, 0.90).toFixed(2)}`);
console.log(`min / max       ${allTotals[0]} / ${allTotals[allTotals.length - 1]}`);
console.log(`sd              ${Math.sqrt(allTotals.reduce((a, v) => a + (v - mean) ** 2, 0) / managerSeasons).toFixed(2)}`);
console.log(`\nmean pts / week / manager   ${(mean / WEEKS).toFixed(3)}`);
console.log(`mean best-minus-worst gap   ${(gaps.reduce((a, b) => a + b, 0) / SEASONS).toFixed(2)}`);

console.log('\n=== PER ACHIEVEMENT (per manager) ===');
console.log('id                pts   P(win)/wk   wins/season   pts/season   share');
const rows = ACHIEVEMENTS.map((a) => {
  const total = winCounts[a.id] ?? 0;
  const pWeek = total / (SEASONS * WEEKS * TEAMS);
  const perSeason = (total * a.points) / managerSeasons;
  return { id: a.id, points: a.points, pWeek, winsSeason: (total / managerSeasons), perSeason };
});
for (const r of rows) {
  console.log(
    `${r.id.padEnd(17)} ${String(r.points).padStart(3)}   ${(r.pWeek * 100).toFixed(2).padStart(7)}%   ` +
    `${r.winsSeason.toFixed(2).padStart(11)}   ${r.perSeason.toFixed(2).padStart(10)}   ` +
    `${((r.perSeason / mean) * 100).toFixed(1).padStart(5)}%`
  );
}
const check = rows.reduce((a, r) => a + r.perSeason, 0);
console.log(`${'TOTAL'.padEnd(17)}     ${' '.repeat(8)}   ${' '.repeat(11)}   ${check.toFixed(2).padStart(10)}`);

console.log('\n=== above-median vs everything else ===');
console.log(`above-median    ${aboveMedianPts.toFixed(2)} pts/season  (${((aboveMedianPts / mean) * 100).toFixed(1)}% of total)`);
console.log(`everything else ${(mean - aboveMedianPts).toFixed(2)} pts/season  (${(((mean - aboveMedianPts) / mean) * 100).toFixed(1)}%)`);

console.log('\n=== compute() errors ===');
const errKeys = Object.keys(errors);
console.log(errKeys.length ? JSON.stringify(errors, null, 2) : 'none - every achievement computed cleanly every week.');
