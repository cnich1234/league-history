import { LEAGUE_SD } from './odds.js';
import { startingSlotsOf } from './lineup.js';

/**
 * Position battles: one side's starters at a position against the other's.
 *
 * They used to add up EVERY starter at the position, flex included. So a
 * manager with an RB in his flex had three RBs against two, and the line was
 * mostly the flex: week 3 of 2026 had "I cashed RBs -18.5" when the two
 * sides' dedicated RBs were five points apart, and Kyren Williams in the flex
 * was the other 13.6. It was also a cheap lever. Swap that RB for a WR of
 * nearly the same projection and two battles swing by ten-plus points each,
 * for a couple of points of real lineup.
 *
 * Now every battle compares the same number of players on each side, taken
 * from the league's dedicated slots -- 1 QB, 2 RB, 3 WR, 1 TE -- and each side
 * counts its BEST scorers at the position, wherever Sleeper has them slotted.
 * Whoever is left over is the FLEX battle, so the five battles between them
 * cover every skill starter exactly once.
 *
 * Settlement and pricing both go through battleScore, so the price is always
 * for the bet as it will actually be settled.
 */

/** Positions a FLEX slot takes. */
export const FLEX_FROM = ['RB', 'WR', 'TE'];
const BATTLE_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * How many dedicated slots each battle position has, from roster_positions.
 * `flex` is how many FLEX slots there are; zero means no FLEX battle.
 */
export function battleCounts(slots) {
  const counts = {};
  let flex = 0;
  for (const s of startingSlotsOf(slots)) {
    if (BATTLE_POSITIONS.includes(s)) counts[s] = (counts[s] ?? 0) + 1;
    if (s === 'FLEX') flex++;
  }
  return { counts, flex };
}

const sum = (xs) => xs.reduce((t, p) => t + p.points, 0);
const best = (players, position) =>
  players.filter((p) => p.position === position).sort((a, b) => b.points - a.points);

/**
 * One side's total in a battle, from the players it STARTED.
 *
 * `players` is [{ position, points }]. Returns null when there is nobody to
 * count, which voids the bet rather than losing it: a side that started no TE
 * was never in a TE battle.
 *
 * A market without `counts` predates the rule and is scored the old way,
 * every starter at the position, so settled history never changes meaning.
 */
export function battleScore(players, { position, counts }) {
  if (!counts) {
    const at = players.filter((p) => p.position === position);
    return at.length ? sum(at) : null;
  }
  if (position === 'FLEX') {
    const extras = FLEX_FROM.flatMap((pos) => best(players, pos).slice(counts[pos] ?? 0));
    return extras.length ? sum(extras) : null;
  }
  const at = best(players, position);
  return at.length ? sum(at.slice(0, counts[position] ?? at.length)) : null;
}

/** Deterministic PRNG, so a dry run prices exactly what the real run writes. */
function rng(seedText) {
  let h = 2166136261;
  for (const c of String(seedText)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lines and cover probabilities for a matchup's battles, by simulation.
 *
 * A formula cannot price these any more: "best two of three RBs" is worth more
 * than the top two projections, and the flex -- whoever is left over -- is
 * worth less than his own projection, because he is by definition the one who
 * had the worse day. So each player is drawn around his projection, each draw
 * is scored with battleScore exactly as settlement will score it, and the line
 * is set where the margin splits the draws in half.
 *
 * Per-player sd is LEAGUE_SD / 3, the same spread the old formula used: nine
 * starters at that sd add up to the fitted whole-lineup LEAGUE_SD.
 *
 * `home` and `away` are [{ position, projection }]. Returns, per battle,
 * { favouriteSide, line, pCover }, or null when either side has nobody to
 * count.
 */
export function priceBattles(home, away, battles, { sims = 20000, seed = 'battles', sd = LEAGUE_SD / 3 } = {}) {
  const rand = rng(seed);
  const normal = () => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const draw = (side) => side.map((p) => ({ position: p.position, points: p.projection + sd * normal() }));

  const results = battles.map((b) =>
    battleScore(home.map((p) => ({ ...p, points: p.projection })), b) == null ||
    battleScore(away.map((p) => ({ ...p, points: p.projection })), b) == null
      ? null
      : [],
  );
  for (let i = 0; i < sims; i++) {
    const h = draw(home);
    const a = draw(away);
    battles.forEach((b, j) => {
      if (results[j]) results[j].push(battleScore(h, b) - battleScore(a, b));
    });
  }

  return results.map((margins) => {
    if (!margins) return null;
    const sorted = margins.slice().sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const favIsHome = median >= 0;
    // Half-point lines, so a push cannot happen -- same rounding as before.
    const raw = Math.round(Math.abs(median) * 2) / 2;
    const line = Number.isInteger(raw) ? raw + 0.5 : raw;
    const covers = margins.filter((m) => (favIsHome ? m : -m) > line).length;
    return { favouriteSide: favIsHome ? 'home' : 'away', line, pCover: covers / margins.length };
  });
}

/** "RBs", "QB", "FLEX" -- how a battle names its side's players. */
export function battleNoun(position, counts) {
  if (position === 'FLEX') return 'FLEX';
  return (counts?.[position] ?? 1) > 1 ? `${position}s` : position;
}

const WORDS = ['', 'one', 'two', 'three', 'four', 'five'];

/** The question a battle asks, in words, for the market's subtitle. */
export function battleQuestion(position, counts, fav, dog, line) {
  if (position === 'FLEX') {
    const kept = FLEX_FROM.filter((p) => counts[p])
      .map((p) => `${counts[p] > 1 ? `best ${WORDS[counts[p]] ?? counts[p]} ` : ''}${battleNoun(p, counts)}`);
    const list = kept.length > 1 ? `${kept.slice(0, -1).join(', ')} and ${kept.at(-1)}` : kept[0];
    return `Does ${fav}'s flex outscore ${dog}'s by more than ${line}? The flex is whoever starts beyond each side's ${list}.`;
  }
  const n = counts[position] ?? 1;
  return n > 1
    ? `Do ${fav}'s best ${WORDS[n] ?? n} starting ${position}s outscore ${dog}'s by more than ${line}?`
    : `Does ${fav}'s starting ${position} outscore ${dog}'s by more than ${line}?`;
}
