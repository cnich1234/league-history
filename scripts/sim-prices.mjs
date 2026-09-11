/**
 * What should a boost cost?
 *
 * The catalogue was priced when the points simulation said a manager earned
 * about 27 trophy points a season. It now says 98.8, and the allowance adds
 * another 70-98 on top -- so a season's income is roughly seven times what the
 * prices assume. At today's numbers a season buys 39 Slow Plays or 16 Voids,
 * which makes every choice free: you never have to decide between two boosts
 * because you can have both, twice.
 *
 * This prices from the other direction. Decide how many of each TIER somebody
 * should be able to afford across a season, then divide income by that.
 *
 *   price = season income / intended uses
 *
 * The tiers are a judgement about what the game should feel like, and they are
 * written down here rather than buried in a number:
 *
 *   staple      ~12/season   something you do most weeks
 *   common       ~7/season   twice a month
 *   considered   ~4/season   once a month, a real decision
 *   rare         ~2.5/season a couple of times all year
 *   signature    ~1.5/season basically once, and everybody remembers it
 *
 * Run: node scripts/sim-prices.mjs [allowancePerWeek] [trophyPointsPerSeason]
 */

import { BOOSTS } from '../lib/boosts.js';

const WEEKS = 14;
const ALLOWANCE = Number(process.argv[2] ?? 7);
// Default from the latest scripts/sim-points.mjs run.
const TROPHY = Number(process.argv[3] ?? 98.77);
const INCOME = TROPHY + ALLOWANCE * WEEKS;

const TIERS = {
  staple: 12,
  common: 7,
  considered: 4,
  rare: 2.5,
  signature: 1.5,
};

/**
 * Which tier each boost belongs in.
 *
 * Judgement, not arithmetic. The rules of thumb:
 *
 *   - informational and small defensive things are staples; they should never
 *     be the reason somebody cannot afford to play
 *   - blind attacks are common: they are a gamble, and a gamble you can only
 *     take twice a season is not a gamble, it is a ceremony
 *   - anything certain, or anything that removes risk, is rare -- Undo and The
 *     Void end an outcome rather than nudging it
 *   - the two that rewrite a whole week are signature
 */
const TIER_OF = {
  receipt: 'staple',
  insurance: 'staple',
  'odds-boost': 'common',
  ghost: 'common',
  'cash-out': 'common',
  hedge: 'common',
  'lock-in': 'common',
  'ride-along': 'common',
  'slow-play': 'common',
  'blind-sabotage': 'common',
  tithe: 'common',
  'payout-cut': 'considered',
  mirror: 'considered',
  steal: 'considered',
  'boost-50': 'considered',
  switcheroo: 'rare',
  'market-poison': 'rare',
  void: 'rare',
  'boost-week': 'signature',
  'week-curse': 'signature',
  undo: 'signature',
};

const round = (n) => {
  // Prices are small integers people hold in their head. Round to something
  // tidy rather than to 13.4: under 10 to the point, over 10 to the nearest 5.
  if (n < 10) return Math.max(1, Math.round(n));
  return Math.round(n / 5) * 5;
};

console.log(`\nIncome model: ${ALLOWANCE}/wk allowance x ${WEEKS} weeks + ${TROPHY} trophy`);
console.log(`Season income: ${INCOME.toFixed(1)} points\n`);

console.log('tier        uses/season   price');
for (const [tier, uses] of Object.entries(TIERS)) {
  console.log(`${tier.padEnd(12)}${String(uses).padStart(6)}${String(round(INCOME / uses)).padStart(9)}`);
}

console.log('\nboost                 tier          now    ->  suggested    change');
const rows = [];
let missing = 0;
for (const b of [...BOOSTS].sort((a, b) => a.cost - b.cost)) {
  const tier = TIER_OF[b.kind];
  if (!tier) {
    console.log(`  !! ${b.kind} has no tier`);
    missing++;
    continue;
  }
  const price = round(INCOME / TIERS[tier]);
  rows.push({ kind: b.kind, name: b.name, tier, now: b.cost, price });
  const delta = price - b.cost;
  console.log(
    `${b.name.padEnd(22)}${tier.padEnd(13)}${String(b.cost).padStart(4)}    ->${String(price).padStart(8)}` +
      `${(delta >= 0 ? '     +' : '     ') + delta}`,
  );
}
if (missing) console.log(`\n${missing} boost(s) missing a tier -- add them to TIER_OF.`);

console.log('\n=== what a season buys at the suggested prices ===');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(22)}${(INCOME / r.price).toFixed(1).padStart(6)} per season`);
}

// The weekly allowance on its own should still buy something, or a manager who
// wins nothing all season can never participate.
const cheapest = Math.min(...rows.map((r) => r.price));
console.log(
  `\nCheapest boost is ${cheapest}. The allowance alone (${ALLOWANCE}/wk) affords one every ` +
    `${(cheapest / ALLOWANCE).toFixed(1)} week(s).`,
);
if (cheapest > ALLOWANCE * 3) {
  console.log('WARNING: somebody who never wins a trophy waits over three weeks for anything.');
}

// A bounty needs 20% up front, so the poster has to be able to find that.
console.log('\n=== bounty opening stakes at the suggested prices ===');
for (const r of rows.filter((x) => BOOSTS.find((b) => b.kind === x.kind)?.attack)) {
  console.log(
    `  ${r.name.padEnd(22)}cost ${String(r.price).padStart(3)}  ->  poster puts in ${Math.max(1, Math.round(r.price * 0.2))}`,
  );
}

console.log('\nCopy into lib/boosts.js:');
for (const r of rows) console.log(`  ${r.kind}: ${r.price},`);
console.log();
