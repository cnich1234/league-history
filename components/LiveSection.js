'use client';

import { useEffect, useState } from 'react';
import LiveScores from './LiveScores';

/**
 * Loads the slim player map, then hands off to LiveScores.
 *
 * Fetched rather than imported so the 6 KB map is not inlined into the JS
 * bundle for every visitor -- most page views are not on a Sunday.
 */
export default function LiveSection({ owners, season = [] }) {
  const [players, setPlayers] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/players.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setPlayers)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return <div className="empty">Could not load player data.</div>;
  if (!players) return <div className="empty">Loading…</div>;
  return <LiveScores owners={owners} players={players} season={season} />;
}
