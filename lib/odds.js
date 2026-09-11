/**
 * American odds helpers and line-making.
 *
 * American odds: negative is the favourite (risk N to win 100), positive is the
 * underdog (risk 100 to win N). Everything is in integer cents -- floats and
 * money do not mix, and a half-cent rounding error compounding over a season is
 * exactly the kind of thing that starts an argument.
 */

/** Total returned on a winning bet, stake included. */
export function payoutCents(stakeCents, odds) {
  const profit =
    odds > 0
      ? Math.round((stakeCents * odds) / 100)
      : Math.round((stakeCents * 100) / Math.abs(odds));
  return stakeCents + profit;
}

/** Profit alone, for display next to a stake. */
export function profitCents(stakeCents, odds) {
  return payoutCents(stakeCents, odds) - stakeCents;
}

/** Implied win probability, including the book's margin. */
export function impliedProbability(odds) {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

/** Probability -> American odds, before any margin is applied. */
export function probabilityToOdds(p) {
  const clamped = Math.min(0.97, Math.max(0.03, p));
  return clamped >= 0.5
    ? -Math.round((clamped / (1 - clamped)) * 100)
    : Math.round(((1 - clamped) / clamped) * 100);
}

/**
 * Two-way price from a raw win probability, with vig baked in.
 *
 * The 4.5% margin is why the house edge exists: bet both sides of everything
 * and you lose slowly. It keeps a season-long bankroll race from being won by
 * whoever placed the most bets.
 */
export function twoWayOdds(pHome, margin = 0.045) {
  // Price each side off its own probability, then add margin to both, so the
  // book takes its cut regardless of which way the money goes.
  const adjHome = Math.min(0.97, pHome + margin / 2);
  const adjAway = Math.min(0.97, 1 - pHome + margin / 2);
  return { home: probabilityToOdds(adjHome), away: probabilityToOdds(adjAway) };
}

/**
 * Weekly scoring standard deviation for one lineup, fitted to this league.
 *
 * 28.0, from 725 regular-season games across 2016-2025 -- measured as
 * sd(margin) / sqrt(2), because the margin is what the model prices and it
 * cancels league-wide weekly effects that lift both sides at once.
 *
 * It was a guess of 25 before, which was close but not this league's number.
 * The figure is stable: season-by-season it ranges 22-31 with no trend, so
 * there is no case for weighting recent years more heavily. Re-fit any time
 * with `node scripts/fit-sd.mjs`.
 *
 * The normal assumption checks out: 28.6% of games are decided by a full
 * margin-sd or more, against the 31.7% a normal distribution predicts.
 */
export const LEAGUE_SD = 28;

/**
 * Win probability for a head-to-head, from projected totals.
 *
 * The difference of two independent scores has sd = LEAGUE_SD * sqrt(2), so a
 * projection edge of one sd is only about a 76% favourite -- which matches how
 * often favourites actually lose here.
 */
export function h2hProbability(projHome, projAway, sd = LEAGUE_SD) {
  const diff = projHome - projAway;
  const combined = sd * Math.SQRT2;
  return normalCdf(diff / combined);
}

/**
 * Live win probability once a week is underway.
 *
 * Follows Stern (1994), the standard model for in-play sports pricing: the
 * outcome is Brownian motion, so variance is additive over time and the
 * standard deviation of what is LEFT scales with the square root of how much
 * is left. Points already scored contribute no variance at all -- they simply
 * shift the centre of the distribution.
 *
 *   remaining SD = full SD x sqrt(remaining projection / total projection)
 *
 * For fantasy the unit of "time" is projected points still to be played rather
 * than a game clock, because a matchup has no clock -- it has twenty players
 * spread across five days. A 30-point lead on Thursday night means almost
 * nothing (95% of the scoring is still to come); the same lead on Sunday
 * evening is decisive.
 *
 * Each side is passed as { scored, remaining }.
 */
export function liveProbability(home, away, sd = LEAGUE_SD) {
  const homeTotal = home.scored + home.remaining;
  const awayTotal = away.scored + away.remaining;
  const margin = homeTotal - awayTotal;

  const totalProjection = home.scored + home.remaining + away.scored + away.remaining;
  const remainingProjection = home.remaining + away.remaining;

  // Everything has played: the result is known, not probabilistic.
  if (remainingProjection <= 0 || totalProjection <= 0) {
    return margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  }

  const share = Math.min(1, remainingProjection / totalProjection);
  const combined = sd * Math.SQRT2 * Math.sqrt(share);
  // Guard against a vanishing denominator in the last few projected points.
  if (combined < 1e-6) return margin > 0 ? 1 : margin < 0 ? 0 : 0.5;

  return normalCdf(margin / combined);
}

/**
 * Live probability that the favourite covers a spread.
 *
 * Same distribution, different question: the margin has to clear the line
 * rather than merely be positive.
 */
export function liveSpreadProbability(favourite, underdog, spread, sd = LEAGUE_SD) {
  return liveProbability(
    { scored: favourite.scored, remaining: favourite.remaining },
    { scored: underdog.scored + spread, remaining: underdog.remaining },
    sd,
  );
}

/**
 * Live probability that one lineup goes over a total.
 *
 * Same machinery as a matchup, but one-sided: only that team's own remaining
 * scoring carries variance, so the sd scales with sqrt of ITS share rather
 * than the pair's.
 */
export function liveTotalProbability(side, line, sd = LEAGUE_SD) {
  const projected = side.scored + side.remaining;
  const total = projected || 1;
  const share = Math.min(1, Math.max(0, side.remaining / total));

  if (side.remaining <= 0) return projected > line ? 1 : 0;

  const spread = sd * Math.sqrt(share);
  if (spread < 1e-6) return projected > line ? 1 : 0;
  return normalCdf((projected - line) / spread);
}

/**
 * Should a market still take bets?
 *
 * Books close on probability, not on a clock -- no sportsbook publishes a time
 * threshold, they all close when one side becomes near-certain, because at
 * 97/3 anyone with a few seconds of information advantage captures nearly the
 * whole 3% at no risk.
 *
 * Two triggers, either of which closes the market:
 *   - one side reaches `threshold` (default 90%)
 *   - less than `minRemaining` of the projected scoring is left, which guards
 *     against the model being confidently wrong with two backups still to play
 */
export function shouldSuspend(probability, remainingShare, { threshold = 0.9, minRemaining = 0.1 } = {}) {
  if (remainingShare < minRemaining) return 'decided';
  // Compare the leading side's probability rather than testing both ends.
  // `probability <= 1 - threshold` looks equivalent but fails on floating
  // point: 1 - 0.9 is 0.09999999999999998, so an exact 10% stayed open.
  const leader = Math.max(probability, 1 - probability);
  if (leader >= threshold) return 'decided';
  return null;
}

/** Abramowitz & Stegun 7.1.26 -- accurate to ~1e-7, no dependency needed. */
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Cents -> "$1,234.56". */
export function formatMoney(cents) {
  const n = Number(cents) / 100;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Odds -> "+150" / "-200". */
export function formatOdds(odds) {
  return odds > 0 ? `+${odds}` : String(odds);
}

/**
 * Combined odds for a parlay.
 *
 * Odds multiply in decimal space, not American: two -110 legs are not -220,
 * they are roughly +264, because you are re-staking the first leg's return on
 * the second. Converting to decimal, multiplying, and converting back is the
 * only way to get this right.
 */
export function parlayOdds(legOdds) {
  if (!legOdds.length) return null;
  const decimal = legOdds.reduce((acc, o) => acc * americanToDecimal(o), 1);
  return decimalToAmerican(decimal);
}

export function americanToDecimal(odds) {
  return odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
}

export function decimalToAmerican(decimal) {
  // A parlay is almost always a plus-money price; the negative branch exists
  // for a two-leg slip of heavy favourites.
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : -Math.round(100 / (decimal - 1));
}

/**
 * Prices for a field of more than two outcomes -- "who has the best RB this
 * week", with one option per manager.
 *
 * `twoWayOdds` cannot do this: it splits a margin across exactly two sides. A
 * ten-way market needs the whole field to sum to 1 + margin, so each price is
 * its own share of that inflated book.
 *
 * Takes raw weights (a projection, or anything monotonic in "how likely"),
 * normalises them, then adds the margin proportionally. Every outcome is
 * floored at 1% so a longshot is priced rather than quoted at absurd odds.
 */
export function fieldOdds(weights, margin = 0.045) {
  const keys = Object.keys(weights);
  if (!keys.length) return {};

  const raw = keys.map((k) => Math.max(0, Number(weights[k]) || 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  // No information at all: price it as an even field rather than dividing by 0.
  const probs = sum > 0 ? raw.map((w) => w / sum) : raw.map(() => 1 / keys.length);

  const out = {};
  keys.forEach((k, i) => {
    const p = Math.min(0.97, Math.max(0.01, probs[i] * (1 + margin)));
    out[k] = probabilityToOdds(p);
  });
  return out;
}

export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 6;

export const MIN_STAKE_CENTS = 1000; // $10

/**
 * Largest single bet: the whole weekly allowance.
 *
 * There is no cap below it. The $250 that used to sit here was a quarter of the
 * old $1,000 season bankroll, and carrying it into a $500 week would have meant
 * two bets spent it -- an arbitrary limit rather than a considered one. The
 * allowance is the limit now.
 *
 * Live markets still taper well below this as a result becomes decided; see
 * maxLiveStake. That cap is about certainty, not affordability, and it still
 * applies.
 */
export const MAX_STAKE_CENTS = 50000; // $500, the weekly allowance

/**
 * Maximum stake on a live market, tapering as the result becomes clearer.
 *
 * A $250 bet on a coin flip and a $250 bet on something 88% decided are very
 * different animals. Real books handle this with discretionary limits that
 * shrink as certainty rises -- none publishes a formula, so this is a
 * deliberate choice rather than an industry rule.
 *
 * Full limit while the market is a genuine contest, then a straight-line taper
 * from `taperFrom` to the suspension threshold, floored at the minimum stake so
 * a market that is still open is always still bettable.
 *
 *   50% certain -> $250      the full limit
 *   75% certain -> $250      still a contest
 *   85% certain -> $125      half
 *   90% certain -> closed
 */
export function maxLiveStake(probability, { taperFrom = 0.75, threshold = 0.9 } = {}) {
  const leader = Math.max(probability, 1 - probability);
  if (leader <= taperFrom) return MAX_STAKE_CENTS;
  if (leader >= threshold) return MIN_STAKE_CENTS;

  const through = (leader - taperFrom) / (threshold - taperFrom);
  const scaled = MAX_STAKE_CENTS - through * (MAX_STAKE_CENTS - MIN_STAKE_CENTS);
  // Round to whole dollars so the cap reads as a number someone would type.
  return Math.max(MIN_STAKE_CENTS, Math.round(scaled / 100) * 100);
}
