'use client';

import { useEffect, useState } from 'react';

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

/**
 * Both lineups side by side, so a bet can be made with the roster in view.
 *
 * Modelled on Sleeper's own matchup screen, but condensed: player, position,
 * opponent, projection, and which day they play. The last one matters here in
 * a way it does not in Sleeper -- markets lock per game day, so knowing a
 * starter plays Thursday explains why a matchup closed on Wednesday.
 */
export default function MatchupModal({ home, away, week, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matchup?home=${home}&away=${away}&week=${week}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [home, away, week]);

  // Escape closes, and the page behind must not scroll while this is open.
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // True once anything in this matchup has scored. Used only for the headline
  // totals; individual players decide for themselves below, so a Sunday starter
  // still shows a projection while a Thursday one shows real points.
  const started = data && (data.home.points > 0 || data.away.points > 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Matchup detail"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">Week {week} matchup</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <div className="empty">{error}</div>}
        {!data && !error && <div className="empty">Loading lineups…</div>}

        {data && (
          <>
            <div className="mm-teams">
              <div className="mm-team">
                <div className="mm-team-name">{data.home.team}</div>
                <div className="mm-team-score">
                  {started ? data.home.points.toFixed(2) : data.home.projected.toFixed(1)}
                </div>
                <div className="mm-team-label">{started ? 'points' : 'projected'}</div>
              </div>
              <div className="mm-vs">vs</div>
              <div className="mm-team">
                <div className="mm-team-name">{data.away.team}</div>
                <div className="mm-team-score">
                  {started ? data.away.points.toFixed(2) : data.away.projected.toFixed(1)}
                </div>
                <div className="mm-team-label">{started ? 'points' : 'projected'}</div>
              </div>
            </div>

            <div className="mm-rows">
              {SLOTS.map((slot, i) => (
                <div className="mm-row" key={i}>
                  <Player p={data.home.players[i]} started={started} align="left" />
                  <span className="mm-slot">{slot}</span>
                  <Player p={data.away.players[i]} started={started} align="right" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Player({ p, started, align }) {
  if (!p) return <span className={`mm-player mm-${align}`} />;
  // A player who has scored is done or playing; one on zero has not started,
  // so their projection is the useful number.
  const live = p.points > 0;
  return (
    <span className={`mm-player mm-${align}`}>
      <span className="mm-name">
        {p.name}
        {p.injury && <span className="mm-injury"> {p.injury.slice(0, 1)}</span>}
      </span>
      <span className="mm-meta">
        {p.team ?? '—'}
        {p.opponent ? ` vs ${p.opponent}` : ''}
        {p.day ? ` · ${p.day}` : ''}
      </span>
      <span className={`mm-points ${live ? '' : 'mm-proj'}`}>
        {live ? p.points.toFixed(1) : (p.projection?.toFixed(1) ?? '—')}
      </span>
    </span>
  );
}
