/**
 * Who can see The Market while it is being built.
 *
 * The feature is hidden rather than switched off: the nav tab, both pages and
 * every API route ask this one question, so opening it to the league later is
 * a one-line change here and nowhere else.
 */
export const MARKET_TESTERS = new Set(['chris-nicholson', 'devin-nicholson']);

export function canSeeMarket(slug) {
  return Boolean(slug) && MARKET_TESTERS.has(slug);
}
