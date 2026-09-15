/**
 * Who can see The Market, and who can trade on it.
 *
 * Both are open to anyone signed in. Each has its own switch: flip
 * MARKET_TRADING_OPEN off and only the testers can buy and sell while
 * everyone else sees the prices and a "coming soon"; flip MARKET_OPEN off
 * and the Market disappears for everyone but the testers. The nav tab, both
 * pages and every API route ask these two functions and nothing else.
 */
export const MARKET_OPEN = true;
export const MARKET_TRADING_OPEN = true;
export const MARKET_TESTERS = new Set(['chris-nicholson', 'devin-nicholson', 'brandon-lowe']);

export function canSeeMarket(slug) {
  if (!slug) return false;
  return MARKET_OPEN || MARKET_TESTERS.has(slug);
}

export function canTrade(slug) {
  if (!canSeeMarket(slug)) return false;
  return MARKET_TRADING_OPEN || MARKET_TESTERS.has(slug);
}
