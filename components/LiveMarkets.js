'use client';

import BetSlip from './BetSlip';
import { useLiveMatchup } from './LiveProvider';
import {
  liveSpreadProbability,
  liveTotalProbability,
  probabilityToOdds,
  maxLiveStake,
} from '@/lib/odds';

// Mirrors LIVE_MARGIN in lib/live.js; importing it would pull the server-only
// Sleeper client into the browser bundle.
const LIVE_MARGIN = 0.09;

/**
 * Renders a group of markets, handing live prices to the ones that have them.
 *
 * A thin client wrapper so BetSlip can stay unaware of where prices come from:
 * it just receives `livePrices` or does not. Only h2h and spread ever get one;
 * everything else renders exactly as before.
 */
export default function LiveMarkets({ homeRoster, awayRoster, markets, myByMarket, bankrollCents }) {
  const state = useLiveMatchup(homeRoster, awayRoster);

  return markets.map((m) => (
    <BetSlip
      key={m.id}
      market={m}
      existingBet={myByMarket[String(m.id)] ?? null}
      bankrollCents={bankrollCents}
      livePrices={pricesFor(m, state)}
    />
  ));
}

/**
 * The live price for one market, or null when there is none -- either because
 * the game has not started, the market is not live, or the model has suspended
 * it because the result is no longer in doubt.
 */
function pricesFor(market, state) {
  if (!market.live || !state || !state.started || state.suspended || !state.odds) return null;

  if (market.kind === 'h2h') {
    return { home: state.odds.home, away: state.odds.away, maxStakeCents: state.maxStakeCents };
  }

  if (market.kind === 'spread') {
    // Priced from the same scored/remaining figures the server uses, so the
    // number on screen matches what placement will compute. The server still
    // prices the bet itself -- this is display only.
    const favIsHome = market.meta.favouriteSlug === market.meta.homeSlug;
    const fav = favIsHome ? state.home : state.away;
    const dog = favIsHome ? state.away : state.home;
    const pCover = liveSpreadProbability(fav, dog, market.meta.spread);
    // Same margin the server uses, or the staleness guard fires on every bet.
    return {
      cover: probabilityToOdds(Math.min(0.97, pCover + LIVE_MARGIN / 2)),
      nocover: probabilityToOdds(Math.min(0.97, 1 - pCover + LIVE_MARGIN / 2)),
      maxStakeCents: maxLiveStake(pCover),
    };
  }

  if (market.kind === 'total') {
    const side = market.meta.rosterId === state.homeRoster ? state.home : state.away;
    const pOver = liveTotalProbability(side, market.meta.line);
    return {
      over: probabilityToOdds(Math.min(0.97, pOver + LIVE_MARGIN / 2)),
      under: probabilityToOdds(Math.min(0.97, 1 - pOver + LIVE_MARGIN / 2)),
      maxStakeCents: maxLiveStake(pOver),
    };
  }

  return null;
}
