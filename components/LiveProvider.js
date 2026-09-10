'use client';

import { createContext, useContext, useEffect, useState } from 'react';

const LiveContext = createContext(null);
const POLL_MS = 15_000;

/**
 * One poll for the whole board, shared by every matchup card.
 *
 * Each card polling for itself meant five identical requests per user per
 * tick. At 15s with ten people that is 200 requests a minute, which works out
 * to roughly half of Vercel Hobby's million monthly invocations across a
 * season -- and overage there pauses the project for 30 days rather than
 * sending a bill. One shared fetch cuts it by 5x.
 *
 * The interval is not limited by our own work: a full recompute measures about
 * 60ms, nearly all of it Sleeper latency with the four calls issued in
 * parallel. It is bounded by how often Sleeper itself updates.
 */
export function LiveProvider({ week, children }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/live?week=${week}`);
        const data = await res.json();
        if (!cancelled && !data.error) setState(data);
      } catch {
        // Leave the last good value on screen; the next tick corrects it.
      }
    };

    load();
    let id = setInterval(load, POLL_MS);

    // A backgrounded tab does not need updates. Browsers throttle timers there
    // anyway, but stopping outright avoids a burst of catch-up requests when
    // the tab comes back.
    const onVisibility = () => {
      clearInterval(id);
      if (document.visibilityState === 'visible') {
        load();
        id = setInterval(load, POLL_MS);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [week]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

/** Live state for one matchup, or null before the first poll lands. */
export function useLiveMatchup(homeRoster, awayRoster) {
  const state = useContext(LiveContext);
  return state?.matchups?.[`${homeRoster}-${awayRoster}`] ?? null;
}
