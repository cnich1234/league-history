import { basePrice } from './price.js';

/**
 * Players who are not playing this week: a bye, or ruled out.
 *
 * Sleeper gives them no projection, and the universe used to drop anyone at
 * zero BEFORE checking who was held -- so on 2026-10-04 somebody's Chase and
 * Barkley showed as "?" at 0.00 and could not be sold. Pure, so the rules are
 * testable without a feed.
 */

/** The size of the board's top cut, before anyone held is added back. */
export const UNIVERSE_SIZE = 150;

/** Who gets a stock this week: the top of the projections, and anyone held. */
export function keepInUniverse(p, i, wanted) {
  if (wanted.has(String(p.id))) return true;
  return Number(p.projection) > 0 && i < UNIVERSE_SIZE;
}

/**
 * What an idle player trades at: his last recorded price, frozen and still
 * tradable (Chris's call). Priced off the zero instead, he would sit at the
 * floor all week and jump back after -- a free trade for anyone watching the
 * bye schedule. Never seen on the log, he gets what the model says.
 */
export function idlePrice(lastPrice, premium = 0) {
  return Number.isFinite(lastPrice) ? lastPrice : basePrice(0, premium);
}
