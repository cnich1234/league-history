'use client';

import { useEffect, useState } from 'react';

const POLL_MS = 30_000;

/**
 * Live win probability for one matchup, polled from the server.
 *
 * Polling rather than a socket: on Vercel's Hobby plan an open connection
 * holds a function instance alive and bills against a 360 GB-hr monthly
 * memory budget, and exceeding it pauses the project for 30 days. Polling
 * spends invocations instead, of which there are a million a month. At ten
 * users watching fantasy scores, 30 seconds of staleness is not noticeable.
 */
export default function LiveProbability({ homeRoster, awayRoster, week }) {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/live?week=${week}`);
        const data = await res.json();
        if (cancelled || data.error) return;
        setState(data.matchups?.[`${homeRoster}-${awayRoster}`] ?? null);
      } catch {
        // A failed poll leaves the last good value on screen rather than
        // blanking it; the next tick will correct it.
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [homeRoster, awayRoster, week]);

  if (!state || !state.started) return null;

  const home = Math.round(state.probability * 100);
  const away = 100 - home;

  return (
    <div className="livebar">
      <div className="livebar-head">
        <span className="livebar-side">
          {state.homeName} <strong>{home}%</strong>
        </span>
        <span className="livebar-side livebar-right">
          <strong>{away}%</strong> {state.awayName}
        </span>
      </div>
      <div className="livebar-track">
        <div className="livebar-fill" style={{ width: `${home}%` }} />
      </div>
      <div className="livebar-meta">
        {state.home.scored} – {state.away.scored} · {Math.round(state.remainingShare * 100)}% left
        to play
        {state.suspended && <span className="livebar-shut"> · betting closed</span>}
      </div>
    </div>
  );
}
