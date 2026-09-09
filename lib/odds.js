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
 * Win probability for a head-to-head, from projected totals.
 *
 * Fantasy weekly scores are roughly normal with a standard deviation around 25
 * points in PPR. The difference of two independent scores has sd = 25*sqrt(2),
 * so a projection edge of one sd is only about a 76% favourite -- which matches
 * how often favourites actually lose in this league.
 */
export function h2hProbability(projHome, projAway, sd = 25) {
  const diff = projHome - projAway;
  const combined = sd * Math.SQRT2;
  return normalCdf(diff / combined);
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

export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 6;

export const MIN_STAKE_CENTS = 1000; // $10
export const MAX_STAKE_CENTS = 25000; // $250
