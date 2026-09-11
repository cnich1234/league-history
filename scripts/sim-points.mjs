/**
 * Monte Carlo: how many achievement points does a manager actually earn?
 *
 * Simulates whole seasons of this 10-team league, builds the exact `week`
 * object that lib/weekly.js + scripts/build-weekly.mjs pass to each
 * achievement's compute(), and runs the real ACHIEVEMENTS array against it.
 *
 * The generator mirrors buildWeek() field for field: teams carry points,
 * benchPoints, missedPoints, projected, worstBenchMistake, winStreak,
 * winPctBefore and recordBefore; games carry margin, upset, loser*, and a
 * `sides` array with expectedMargin/actualMargin; allStarters entries carry
 * position, points, projected, recYards, rushYards and played.
 *
 * Calibration inputs, none of them tuned to produce a nice answer:
 *   - team score N(120, 28), LEAGUE_SD fitted from 725 real games
 *   - a persistent per-team season strength, so projections are a real forecast
 *     rather than a leaked copy of the result
 *   - 2025 NFL reality: 150+ receiving yards happened 18 times in 17 weeks,
 *     150+ rushing yards 16 times, scaled down to the ~60 skill starters this
 *     10-team league actually fields
 *
 * Run: node scripts/sim-points.mjs [seasons]
 */

import { ACHIEVEMENTS } from './achievements.mjs';

const SEASONS = Number(process.argv[2]) || 4000;
const TEAMS = 10;
const WEEKS = 14;
const TEAM_MEAN = 120;
const TEAM_SD = 28; // LEAGUE_SD from lib/odds.js

// A team's score is a persistent season-long strength plus week noise. The two
// variances add to TEAM_SD^2 (10^2 + 26^2 ~= 28^2), so the league-wide spread
// still matches the fitted distribution while good teams stay good.
const STRENGTH_SD = 10;
const WEEK_SD = 26;
// Projection error. Sleeper's projection is a forecast of your true strength,
// not a peek at the result, so "beat your projection" is near enough a coin
// flip -- which is what that award is supposed to be.
const PROJ_SD = 8;

// Starting lineup: 1 QB, 2 RB, 3 WR, 1 TE, 1 K, 1 DEF = 9.
const LINEUP = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'K', 'DEF'];
// Bench: 5 players, drawn from the skill positions that matter for awards
// plus the odd kicker/defence, same distributions.
const BENCH = ['QB', 'RB', 'RB', 'WR', 'WR'];
const POS_MEAN = { QB: 18, RB: 11, WR: 10, TE: 8, K: 8, DEF: 8 };
const POS_SD_FRAC = 0.4;
// Defences swing much harder in relative terms and are the only position that
// can finish below zero. 0.75 of an 8-point mean puts a negative week at about
// 14%, which is close to how often it really happens.
const DEF_SD_FRAC = 0.75;
// Transactions. A 10-team league sees a handful of trades a season and waiver
// claims every week; both drive awards worth 12 points between them, and
// neither was modelled at all.
const TRADES_PER_SEASON = 6;
const PICKUPS_PER_TEAM_WEEK = 0.55;
// Share of bench players who actually suit up. The rest are hurt or on bye and
// could not have been started, so they cannot count against the lineup award.
const BENCH_PLAY_RATE = 0.8;

// Yardage model, calibrated against real 2025 output. A 150-yard receiving game
// happened 18 times in 17 NFL weeks and a 150-yard rushing game 16 times, i.e.
// about one of each per week league-wide. Only players started in THIS league
// count, and big games cluster among exactly the players who get started, so
// roughly 85% of them land on someone's starting lineup here:
//   rec:  18/17 * 0.85 / 40 WR+TE starters ~= 2.25% per starter-week
//   rush: 16/17 * 0.85 / 20 RB starters    ~= 4.00% per starter-week
// A lognormal per position reproduces those tail rates without a special case.
// Fitted so 30 WR + 10 TE starters yield 0.94 rec-150 games a week and 20 RB
// starters yield 0.87 rush-150 games -- the real rates, scaled to this league.
const YARDS = {
  WR: { mu: 4.02, sigma: 0.53 }, // median ~56 rec yds, P(>=150) ~ 3.1%
  TE: { mu: 3.52, sigma: 0.50 }, // median ~34 rec yds, P(>=150) ~ 0.14%
  RB: { mu: 3.95, sigma: 0.62 }, // median ~52 rush yds, P(>=150) ~ 4.4%
};

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
 * Rushing and receiving yards for one player-week.
 *
 * Only WR/TE get receiving yards and only RB gets meaningful rushing yards,
 * matching what the two yardage awards look at. A player who did not play puts
 * up nothing, so `played` and the yards stay consistent.
 */
function drawYards(pos, played) {
  if (!played) return { recYards: 0, rushYards: 0 };
  const spec = YARDS[pos];
  if (!spec) return { recYards: 0, rushYards: 0 };
  const yds = Math.round(Math.exp(normal(spec.mu, spec.sigma)));
  return pos === 'RB' ? { recYards: 0, rushYards: yds } : { recYards: yds, rushYards: 0 };
}

/**
 * One roster's players for a week.
 *
 * Per-player draws are scaled so the 9 starters sum to `target`, the team score
 * drawn from its season strength plus week noise. Without the rescale the
 * starters would sum to a much tighter distribution than the league actually
 * shows (sum of 9 independent normals has sd ~ 14, not 28), and every
 * margin-based award would be wrong.
 */
function drawRoster(target) {
  const draw = (pos, played = true) => ({
    position: pos,
    // Defences can and do go negative -- a pick-six and a few sacks against is
    // a minus week. Clamping every position at zero made "negative defense"
    // impossible to win, so the sim scored it at 0.000 wins/season while the
    // award is worth 2 points.
    points: played
      ? round2(
          pos === 'DEF'
            ? normal(POS_MEAN[pos], POS_MEAN[pos] * DEF_SD_FRAC)
            : Math.max(0, normal(POS_MEAN[pos], POS_MEAN[pos] * POS_SD_FRAC)),
        )
      : 0,
    played,
    ...drawYards(pos, played),
  });
  const starters = LINEUP.map((pos) => draw(pos, true));
  // Roughly a fifth of the bench is inactive or on bye in any given week.
  const bench = BENCH.map((pos) => draw(pos, rand() < BENCH_PLAY_RATE));

  const raw = starters.reduce((a, p) => a + p.points, 0);
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

/**
 * Startable points left on the bench, identical logic to buildWeek(): only
 * players who actually PLAYED, and only the surplus over the weakest starter at
 * the same position.
 */
function missedPoints(starters, bench) {
  return +bench
    .filter((b) => b.played)
    .reduce((total, b) => {
      const swappable = starters.filter((x) => x.position === b.position);
      const weakest = [...swappable].sort((x, y) => x.points - y.points)[0];
      return weakest && b.points > weakest.points ? total + (b.points - weakest.points) : total;
    }, 0)
    .toFixed(2);
}

function simulateSeason(errors) {
  const prior = Object.fromEntries(SLUGS.map((s) => [s, { w: 0, l: 0, streak: 0 }]));
  const seasonPoints = Object.fromEntries(SLUGS.map((s) => [s, 0]));
  const wins = {}; // achievement id -> count of (manager, week) awards
  // Season-long true strength: some managers really are better than others, and
  // the projection knows it. Redrawn every season.
  const strength = Object.fromEntries(SLUGS.map((s) => [s, normal(TEAM_MEAN, STRENGTH_SD)]));

  for (let week = 1; week <= WEEKS; week++) {
    const teams = [];
    const allStarters = [];

    for (const slug of SLUGS) {
      const truth = strength[slug];
      const target = Math.max(0, normal(truth, WEEK_SD));
      const { starters, bench } = drawRoster(target);
      starters.forEach((p, i) => { p.name = `${slug}-S${i}-${p.position}`; });
      bench.forEach((p, i) => { p.name = `${slug}-B${i}-${p.position}`; });

      const teamPoints = round2(starters.reduce((a, p) => a + p.points, 0));
      // Team projection = forecast of true strength. Spread across starters in
      // proportion to their position mean, so allStarters entries carry a
      // plausible per-player `projected` the way buildWeek()'s do.
      const teamProjected = round2(Math.max(0, normal(truth, PROJ_SD)));
      const meanSum = LINEUP.reduce((a, pos) => a + POS_MEAN[pos], 0);
      for (const [i, s] of starters.entries()) {
        s.projected = round2((POS_MEAN[s.position] / meanSum) * teamProjected);
        allStarters.push({ ...s, slug, id: `${slug}-S${i}` });
      }

      const pr = prior[slug];
      teams.push({
        slug,
        name: slug,
        team: slug,
        points: teamPoints,
        benchPoints: round2(bench.reduce((a, p) => a + p.points, 0)),
        missedPoints: missedPoints(starters, bench),
        projected: teamProjected,
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
      const pair = [order[i], order[i + 1]];
      const [win, lose] = [...pair].sort((a, b) => b.points - a.points);
      games.push({
        winnerSlug: win.slug, winnerName: win.team, winnerPoints: win.points,
        loserSlug: lose.slug, loserName: lose.team, loserPoints: lose.points,
        loserRecordBefore: lose.recordBefore,
        margin: round2(win.points - lose.points),
        upset: lose.winPctBefore > win.winPctBefore,
        // Both sides, so "did you beat the spread" can be asked of the loser as
        // well as the winner -- exactly as buildWeek() emits it.
        sides: pair.map((t) => {
          const opp = pair.find((x) => x.slug !== t.slug);
          return {
            slug: t.slug,
            points: t.points,
            projected: t.projected,
            expectedMargin:
              t.projected == null || opp.projected == null ? null : round2(t.projected - opp.projected),
            actualMargin: round2(t.points - opp.points),
          };
        }),
      });
    }

    // Waiver pickups. A claim only counts for the award if the player is in
    // the lineup, so these point at a random STARTER -- the same thing the real
    // feed produces when somebody picks up a player and starts him.
    const pickups = [];
    for (const slug of SLUGS) {
      if (rand() >= PICKUPS_PER_TEAM_WEEK) continue;
      const mine = allStarters.filter((p) => p.slug === slug);
      if (!mine.length) continue;
      const pick = mine[Math.floor(rand() * mine.length)];
      pickups.push({ slug, playerId: pick.id });
    }

    // Trades. Spread across the season rather than one a week: both managers
    // in a trade get the award, which is why this pushes two slugs.
    const traded = [];
    if (rand() < TRADES_PER_SEASON / WEEKS) {
      const a = SLUGS[Math.floor(rand() * SLUGS.length)];
      let b = SLUGS[Math.floor(rand() * SLUGS.length)];
      while (b === a) b = SLUGS[Math.floor(rand() * SLUGS.length)];
      traded.push(a, b);
    }

    const w = {
      teams,
      games,
      allStarters,
      pickups,
      traded,
      median: median(teams.map((t) => t.points)),
    };

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
console.log(`Team score model: strength N(${TEAM_MEAN}, ${STRENGTH_SD}) + week noise N(0, ${WEEK_SD})  ~=  N(${TEAM_MEAN}, ${Math.round(Math.hypot(STRENGTH_SD, WEEK_SD))})`);
console.log(`Projection: strength + N(0, ${PROJ_SD})\n`);

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

// ---------- allowance split ----------
// The shop hands out a flat WEEKLY_ALLOWANCE every week on top of trophy
// points. A 50/50 split means the season's allowance equals the season's trophy
// haul for a typical (median) manager.
console.log('\n=== WEEKLY ALLOWANCE vs TROPHY POINTS ===');
const trophyMedian = pct(allTotals, 0.5);
console.log(`trophy pts/season: mean ${mean.toFixed(2)}, median ${trophyMedian.toFixed(2)}  over ${WEEKS} weeks`);
console.log(`50/50 allowance = ${(mean / WEEKS).toFixed(2)} /wk on the mean, ${(trophyMedian / WEEKS).toFixed(2)} /wk on the median`);
console.log('\nallow/wk   allowance/season   trophy/season   allowance share   trophy share');
for (const allowance of [2, 3, 4, 5]) {
  const season = allowance * WEEKS;
  const tot = season + mean;
  console.log(
    `${String(allowance).padStart(8)}   ${season.toFixed(0).padStart(16)}   ${mean.toFixed(2).padStart(13)}   ` +
    `${((season / tot) * 100).toFixed(1).padStart(14)}%   ${((mean / tot) * 100).toFixed(1).padStart(11)}%`
  );
}

// ---------- tuning flags ----------
console.log('\n=== TUNING FLAGS ===');
const flags = [];
for (const r of rows) {
  const share = r.perSeason / mean;
  if (share > 0.25) flags.push(`OUTSIZED  ${r.id.padEnd(17)} ${(share * 100).toFixed(1)}% of all points (${r.perSeason.toFixed(2)} pts/season)`);
  if (r.winsSeason < 0.1) flags.push(`TOO RARE  ${r.id.padEnd(17)} ${r.winsSeason.toFixed(3)} wins/season (${(r.pWeek * 100).toFixed(3)}%/wk)`);
}
console.log(flags.length ? flags.join('\n') : 'none - every award is inside 0.1 wins/season and 25% of total.');

console.log('\n=== compute() errors ===');
const errKeys = Object.keys(errors);
console.log(errKeys.length ? JSON.stringify(errors, null, 2) : 'none - every achievement computed cleanly every week.');
