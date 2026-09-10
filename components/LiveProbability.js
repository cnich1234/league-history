'use client';

import { useLiveMatchup } from './LiveProvider';

/**
 * Live win probability for one matchup.
 *
 * Reads from the shared LiveProvider rather than polling itself -- five cards
 * each fetching independently was five identical requests per user per tick.
 */
export default function LiveProbability({ homeRoster, awayRoster }) {
  const state = useLiveMatchup(homeRoster, awayRoster);
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
