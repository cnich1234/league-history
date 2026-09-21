/**
 * How a bet WOULD settle, for bets that have not settled yet.
 *
 * The Action shows bets whose games are over but whose settlement has not run
 * -- it runs on Tuesday, and the last game finishes on Monday night. In that
 * window the page said only "Closed", which is true and useless: the result is
 * sitting in the final scores, everybody watching knows it, and the page was
 * the only thing pretending not to.
 *
 * So this projects the outcome from the same scores settlement will use, via
 * the same resolveMarket. Reusing the real resolver is the point: an indicator
 * computed a second way could disagree with the money, and then the page is
 * worse than silent.
 *
 * NOTHING HERE WRITES. It reads Sleeper and the markets and returns a verdict;
 * the bet stays pending until the cron settles it for real.
 *
 * A parlay is won only when every leg is, and lost the moment one leg is --
 * which is the standard rule and also what settleParlays does. A void or
 * pushed leg drops out rather than killing it.
 */
import { resolveMarket } from './settle.js';

/** 'won' | 'lost' | 'push' | 'void' | null when it cannot be called yet. */
function outcomeFor(market, optionKey, inputs) {
  const winner = resolveMarket(market, inputs);
  if (winner == null) return null;
  if (winner === 'void') return 'void';
  if (winner === 'push') return 'push';
  return String(optionKey) === String(winner) ? 'won' : 'lost';
}

/**
 * Standing results for a set of pending bets, keyed by bet id.
 *
 * `bets` is [{ id, market, optionKey }] for straight bets and
 * [{ id, legs: [{ market, optionKey }] }] for parlays, where `market` carries
 * kind, meta, season and week.
 *
 * `loadInputs(season, week)` returns the scoring inputs for a week, or null
 * when that week has no scores. Injected so this stays testable.
 */
export async function standingResults(bets, loadInputs) {
  const cache = new Map();
  const inputsFor = async (season, week) => {
    const key = `${season}-${week}`;
    if (!cache.has(key)) cache.set(key, await loadInputs(season, week).catch(() => null));
    return cache.get(key);
  };

  const out = {};
  for (const bet of bets) {
    if (bet.market) {
      const inputs = await inputsFor(bet.market.season, bet.market.week);
      if (!inputs) continue;
      const res = outcomeFor(bet.market, bet.optionKey, inputs);
      if (res) out[bet.id] = res;
      continue;
    }

    const legs = bet.legs ?? [];
    if (!legs.length) continue;
    let allKnown = true;
    let anyLost = false;
    let live = 0;
    for (const leg of legs) {
      const inputs = await inputsFor(leg.market.season, leg.market.week);
      const res = inputs ? outcomeFor(leg.market, leg.optionKey, inputs) : null;
      if (res === 'lost') {
        anyLost = true;
        break;
      }
      // A void or pushed leg drops out of the parlay rather than killing it,
      // the same as settleParlays. It just does not count toward "all won".
      if (res === 'won') live++;
      else if (res !== 'void' && res !== 'push') allKnown = false;
    }
    if (anyLost) out[bet.id] = 'lost';
    else if (allKnown) out[bet.id] = live > 0 ? 'won' : 'void';
  }
  return out;
}
