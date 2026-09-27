'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { MAX_PARLAY_LEGS } from '@/lib/odds';

const SlipContext = createContext(null);

/**
 * The parlay slip: legs selected across the whole board.
 *
 * Lives in context rather than in each BetSlip because a parlay spans markets,
 * and the floating slip at the bottom has to know about selections made three
 * matchup cards away.
 *
 * Deliberately not persisted. A half-built slip surviving a reload sounds
 * helpful until a leg has locked in the meantime, at which point the server
 * rejects the whole thing and the reason is not obvious.
 */
export function SlipProvider({ children }) {
  const [legs, setLegs] = useState([]);

  const value = useMemo(
    () => ({
      legs,
      // The slip stops taking NEW markets at the parlay limit. It used to take
      // a seventh, and the slip then hid its stake box and Review button
      // behind a small grey "Maximum 6 legs" -- on a phone that read as a
      // button you could not scroll to.
      full: legs.length >= MAX_PARLAY_LEGS,
      has: (marketId) => legs.some((l) => l.marketId === String(marketId)),
      selected: (marketId, optionKey) =>
        legs.some((l) => l.marketId === String(marketId) && l.optionKey === optionKey),
      toggle: (leg) =>
        setLegs((current) => {
          const id = String(leg.marketId);
          const existing = current.find((l) => l.marketId === id);
          // Tapping the same side again removes it; tapping the other side of a
          // market already in the slip swaps it, since both can never win.
          if (existing && existing.optionKey === leg.optionKey) {
            return current.filter((l) => l.marketId !== id);
          }
          // Swapping the side of a market already in the slip is always fine;
          // a new market past the limit is not.
          if (!existing && current.length >= MAX_PARLAY_LEGS) return current;
          const without = current.filter((l) => l.marketId !== id);
          return [...without, { ...leg, marketId: id }];
        }),
      remove: (marketId) =>
        setLegs((current) => current.filter((l) => l.marketId !== String(marketId))),
      clear: () => setLegs([]),
    }),
    [legs],
  );

  return <SlipContext.Provider value={value}>{children}</SlipContext.Provider>;
}

export function useSlip() {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error('useSlip must be used inside a SlipProvider.');
  return ctx;
}
