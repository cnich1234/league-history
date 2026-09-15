/**
 * Who can see The Market, and who can trade on it.
 *
 * Seeing is open to anyone signed in. Trading is behind its own switch while
 * it is tested: the testers can buy and sell, everyone else sees the prices
 * and a "coming soon". The nav tab, both pages and every API route ask these
 * two functions, so opening trading to the league is flipping
 * MARKET_TRADING_OPEN here and nowhere else.
 */
export const MARKET_OPEN = true;
export const MARKET_TRADING_OPEN = false;
export const MARKET_TESTERS = new Set(['chris-nicholson', 'devin-nicholson', 'brandon-lowe']);

export function canSeeMarket(slug) {
  if (!slug) return false;
  return MARKET_OPEN || MARKET_TESTERS.has(slug);
}

export function canTrade(slug) {
  if (!canSeeMarket(slug)) return false;
  return MARKET_TRADING_OPEN || MARKET_TESTERS.has(slug);
}
