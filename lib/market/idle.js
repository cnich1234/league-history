import { basePrice, livePrice } from './price.js';

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
 * What an idle player trades at: frozen where he last traded, and still
 * tradable there (Chris's call). Priced off the zero instead, he would sit at
 * the floor all week and jump back after -- a free trade for anyone watching
 * the bye schedule.
 *
 * `last` is his last tick from before he went idle: { price, inputs }. When
 * the inputs are there the price is recomputed from them under TODAY's model
 * rather than copied, so a change to the formula reaches frozen players too.
 * Barkley was ruled out mid-game at a recorded 0.25 an hour before the
 * premium cap landed; recomputed, the same moment is worth 2.00. Ticks from
 * before inputs were logged fall back to the recorded price, and a player
 * never seen at all gets what the model says.
 */
export function idlePrice(last, premium = 0) {
  if (Array.isArray(last?.inputs) && last.inputs.length >= 5) {
    const [points, remaining, projection, , carried] = last.inputs;
    return livePrice({ projection, points, remaining, premium: carried });
  }
  const price = typeof last === 'number' ? last : Number(last?.price);
  return Number.isFinite(price) ? price : basePrice(0, premium);
}
