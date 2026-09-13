/**
 * Who can see The Market.
 *
 * Open to anyone signed in while it is a watch-only preview. The nav tab,
 * both pages and every API route ask this one question, so pulling it back to
 * the testers list -- say, while trading is being built -- is flipping
 * MARKET_OPEN here and nowhere else.
 */
export const MARKET_OPEN = true;
export const MARKET_TESTERS = new Set(['chris-nicholson', 'devin-nicholson', 'brandon-lowe']);

export function canSeeMarket(slug) {
  if (!slug) return false;
  return MARKET_OPEN || MARKET_TESTERS.has(slug);
}
