'use client';

import { useEffect, useState, useCallback } from 'react';
import { ACHIEVEMENTS, byId } from '@/lib/achievements-client';

const LEAGUE_ID = '1389735198932877312';
const POLL_MS = 60_000;

/**
 * Live gameday scoring.
 *
 * The site is a static export, so there is no server to compute this. Sleeper's
 * API is public, read-only and CORS-enabled, so the browser polls it directly
 * and runs the same achievement definitions the build-time script uses. Nothing
 * is persisted -- Tuesday's `build-weekly` run is what makes a week official.
 */
export default function LiveScores({ owners, players, season = [] }) {
  const [state, setState] = useState({ status: 'loading' });
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const nfl = await fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json());
      const week = nfl.week;
      const [users, rosters, matchups] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`).then((r) => r.json()),
        fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`).then((r) => r.json()),
        fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${week}`).then((r) => r.json()),
      ]);

      if (!matchups.some((m) => m.points > 0)) {
        setState({ status: 'nogames', week });
        return;
      }

      const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
      const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

      const teams = [];
      const allStarters = [];

      for (const m of matchups) {
        const r = rosterById[m.roster_id];
        const owner = owners[r?.owner_id];
        if (!owner) continue;
        const u = userById[r.owner_id];
        const pts = m.players_points ?? {};
        const starterIds = (m.starters ?? []).filter((id) => id && id !== '0');
        const benchIds = (m.players ?? []).filter((id) => !starterIds.includes(id));

        const named = (id) => ({
          name: players[id]?.n ?? id,
          position: players[id]?.p ?? '?',
          points: +(pts[id] ?? 0).toFixed(2),
        });
        const starters = starterIds.map(named);
        const bench = benchIds.map(named);
        for (const s of starters) allStarters.push({ ...s, slug: owner.slug });

        let worst = null;
        for (const b of bench) {
          const weakest = starters
            .filter((s) => s.position === b.position)
            .sort((x, y) => x.points - y.points)[0];
          if (weakest && b.points > weakest.points) {
            const swing = +(b.points - weakest.points).toFixed(2);
            if (!worst || swing > worst.swing) {
              worst = {
                benched: b.name,
                benchedPoints: b.points,
                started: weakest.name,
                startedPoints: weakest.points,
                swing,
              };
            }
          }
        }

        teams.push({
          slug: owner.slug,
          name: owner.name,
          team: u?.metadata?.team_name || owner.name,
          matchupId: m.matchup_id,
          points: +(m.points ?? 0).toFixed(2),
          benchPoints: +bench.reduce((a, b) => a + b.points, 0).toFixed(2),
          worstBenchMistake: worst,
          // Streaks and upsets need prior-week history, which this view does not
          // load. Their achievements simply do not fire live.
          winStreak: 0,
          winPctBefore: 0,
          recordBefore: '',
        });
      }

      const byMatch = {};
      for (const t of teams) (byMatch[t.matchupId] ??= []).push(t);
      const games = Object.values(byMatch)
        .filter((p) => p.length === 2)
        .map((pair) => {
          const [win, lose] = [...pair].sort((a, b) => b.points - a.points);
          return {
            winnerSlug: win.slug,
            winnerName: win.team,
            winnerPoints: win.points,
            loserSlug: lose.slug,
            loserName: lose.team,
            loserPoints: lose.points,
            margin: +(win.points - lose.points).toFixed(2),
            upset: false,
          };
        });

      const scores = teams.map((t) => t.points).sort((a, b) => a - b);
      const mid = Math.floor(scores.length / 2);
      const median = scores.length % 2 ? scores[mid] : (scores[mid - 1] + scores[mid]) / 2;

      const ctx = { teams, games, allStarters, median };
      const awards = [];
      for (const a of ACHIEVEMENTS) {
        for (const w of a.compute(ctx)) {
          awards.push({ achievement: a.id, slug: w.slug, detail: w.detail, points: a.points });
        }
      }
      const totals = {};
      for (const a of awards) totals[a.slug] = (totals[a.slug] ?? 0) + a.points;

      setState({ status: 'ok', week, teams, games, awards, totals, median });
      setUpdated(new Date());
    } catch (e) {
      setState({ status: 'error', message: e.message });
    }
  }, [owners, players]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (state.status === 'loading') return <div className="empty">Loading live scores…</div>;
  if (state.status === 'error') {
    return <div className="empty">Could not reach Sleeper. {state.message}</div>;
  }
  if (state.status === 'nogames') {
    return <div className="empty">Week {state.week} has not kicked off yet.</div>;
  }

  const ranked = Object.entries(state.totals).sort((a, b) => b[1] - a[1]);
  const nameOf = (slug) => state.teams.find((t) => t.slug === slug)?.name ?? slug;

  // Points banked in previous weeks, which is a different number from the
  // projected total above: that one is this week and still moving.
  const bySlug = Object.fromEntries(season.map((r) => [r.slug, r.points]));
  const seasonPoints = (slug) => (slug && bySlug[slug] != null ? bySlug[slug] : 0);

  return (
    <>
      <div className="live-head">
        <span className="live-dot" />
        Week {state.week} · live · median {state.median.toFixed(2)}
        {updated && <span className="dim"> · {updated.toLocaleTimeString()}</span>}
      </div>

      <div className="section-head">
        <h2>Projected Points</h2>
      </div>
      <div className="rows">
        {ranked.map(([slug, pts], i) => (
          <div key={slug} className="row">
            <span className="rank">{i + 1}</span>
            <span className="row-main">
              <span className="row-name">{nameOf(slug)}</span>
              <span className="dim">
                {state.awards
                  .filter((a) => a.slug === slug)
                  .map((a) => byId[a.achievement]?.icon)
                  .join(' ')}
              </span>
            </span>
            <span className={`row-value ${pts < 0 ? 'neg' : ''}`}>{pts > 0 ? `+${pts}` : pts}</span>
          </div>
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 18 }}>
        <h2>Scoreboard</h2>
        <span className="dim">points earned</span>
      </div>
      <div className="rows">
        {state.games.map((g, i) => {
          // Each side gets its own row so the season total can sit beside the
          // right name -- a combined "A vs B" row has nowhere to put two
          // different numbers.
          const sides = [
            { name: g.winnerName, slug: g.winnerSlug, points: g.winnerPoints },
            { name: g.loserName, slug: g.loserSlug, points: g.loserPoints },
          ];
          return (
            <div key={i} className="scoreline">
              {sides.map((side) => (
                <div key={side.slug ?? side.name} className="scoreline-row">
                  <span className="scoreline-name">{side.name}</span>
                  <span className="scoreline-score">{side.points}</span>
                  <span className="scoreline-season">{seasonPoints(side.slug)}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <p className="note">
        Live totals update every minute and are not final. Streak and upset awards need
        completed weeks, so they only appear once the week is scored.
      </p>
    </>
  );
}
