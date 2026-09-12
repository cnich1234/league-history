'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import PlayerPhoto from './PlayerPhoto';

/**
 * Builds a daily fantasy lineup.
 *
 * Ten slots from a pool of ~450 on a phone. The thing that decides whether this
 * is fun or a chore is finding a player, so search is the centre of it: tap a
 * slot, type three letters, take the name. Filtering happens in the browser
 * because a week's pool is small enough to hold, which means typing costs no
 * round trips.
 *
 * Every rule here is re-checked on the server. This is the pleasant version,
 * not the authoritative one.
 */
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

/** Sleeper hosts headshots by player id; defences get their team logo. */
const photo = (p) =>
  p.position === 'DEF'
    ? `https://sleepercdn.com/images/team_logos/nfl/${String(p.nfl_team ?? p.player_id).toLowerCase()}.png`
    : `https://sleepercdn.com/content/nfl/players/${p.player_id}.jpg`;

export default function LineupBuilder({
  contestId,
  week,
  lineup,
  flexPositions,
  cap,
  pool,
  initialSlots = null,
  readOnly = false,
}) {
  const router = useRouter();
  const [slots, setSlots] = useState(
    () => initialSlots ?? Array.from({ length: lineup.length }, () => null),
  );
  const [picking, setPicking] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const byId = useMemo(() => new Map(pool.map((p) => [String(p.player_id), p])), [pool]);
  const filled = slots.filter(Boolean).length;
  const used = slots.reduce((n, id) => n + (id ? Number(byId.get(String(id))?.salary ?? 0) : 0), 0);
  const left = cap - used;
  // What is still affordable per empty slot -- the number that actually decides
  // whether a pick is possible, rather than the raw remainder.
  const empties = lineup.length - filled;
  const perSlot = empties > 0 ? Math.floor(left / empties) : left;

  // What this slot can cost without making the rest unfillable. Every other
  // empty slot needs at least the cheapest player at its own position.
  const budgetFor = useMemo(() => {
    if (picking == null) return cap;
    const cheapest = (slot) => {
      const allowed = slot === 'FLEX' ? flexPositions : [slot];
      const cs = pool.filter((p) => allowed.includes(p.position)).map((p) => Number(p.salary));
      return cs.length ? Math.min(...cs) : 0;
    };
    let reserved = 0;
    for (const [i, slot] of lineup.entries()) {
      if (i === picking || slots[i]) continue;
      reserved += cheapest(slot);
    }
    return left + Number(byId.get(String(slots[picking]))?.salary ?? 0) - reserved;
  }, [picking, left, slots, lineup, pool, flexPositions, byId, cap]);

  /** Candidates for the slot being filled, searched and cheapest-first-affordable. */
  const candidates = useMemo(() => {
    if (picking == null) return [];
    const slot = lineup[picking];
    const allowed = slot === 'FLEX' ? flexPositions : [slot];
    const taken = new Set(slots.filter((s, i) => s && i !== picking).map(String));
    const q = query.trim().toLowerCase();

    return pool
      .filter((p) => allowed.includes(p.position))
      .filter((p) => !taken.has(String(p.player_id)))
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.nfl_team ?? '').toLowerCase().includes(q) ||
          p.position.toLowerCase() === q,
      )
      // Affordable first, dearest within each group.
      //
      // Sorting purely by price and then cutting at 60 hid the entire cheap end
      // of a big position: the FLEX picker offered sixty players from $7,500 up
      // when the budget was $4,200, so every visible row was disabled and the
      // slot looked unfillable. What somebody can actually pick has to be on
      // screen.
      .sort((a, b) => {
        const aFits = Number(a.salary) <= budgetFor;
        const bFits = Number(b.salary) <= budgetFor;
        if (aFits !== bFits) return aFits ? -1 : 1;
        return b.salary - a.salary;
      });
  }, [picking, query, pool, slots, lineup, flexPositions, budgetFor]);

  function choose(player) {
    setSlots((s) => {
      const next = [...s];
      next[picking] = String(player.player_id);
      return next;
    });
    setPicking(null);
    setQuery('');
    setSaved(false);
  }

  function clearSlot(i) {
    setSlots((s) => {
      const next = [...s];
      next[i] = null;
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dfs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contestId, week, slots }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not save that.');
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const complete = filled === lineup.length && used <= cap;

  return (
    <section className="section">
      <div className="dfs-cap">
        <div>
          <div className="dim">Salary left</div>
          <div className={`dfs-left ${left < 0 ? 'neg' : ''}`}>{money(left)}</div>
        </div>
        <div className="dfs-cap-side">
          <div className="dim">
            {filled} of {lineup.length} filled
          </div>
          {empties > 0 && (
            <div className="dim">{money(perSlot)} per empty slot</div>
          )}
        </div>
      </div>

      <div className="dfs-slots">
        {lineup.map((slot, i) => {
          const p = slots[i] ? byId.get(String(slots[i])) : null;
          return (
            <div key={`${slot}-${i}`} className={`dfs-slot ${p ? 'dfs-slot-filled' : ''}`}>
              <span className="dfs-slot-pos">{slot}</span>
              {p ? (
                <>
                  <PlayerPhoto
                    src={photo(p)}
                    name={p.name}
                    position={p.position}
                    size={32}
                  />
                  <span className="dfs-slot-main">
                    <span className="dfs-slot-name">{p.name}</span>
                    <span className="dim">
                      {p.position} · {p.nfl_team ?? '—'} · {p.projection.toFixed(1)} proj
                    </span>
                  </span>
                  <span className="dfs-slot-cost">{money(p.salary)}</span>
                  {!readOnly && (
                    <button
                      type="button"
                      className="dfs-slot-x"
                      onClick={() => clearSlot(i)}
                      aria-label={`Remove ${p.name}`}
                    >
                      ×
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="dfs-slot-empty"
                  disabled={readOnly}
                  onClick={() => {
                    setPicking(i);
                    setQuery('');
                  }}
                >
                  Add a {slot === 'FLEX' ? 'RB, WR or TE' : slot}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <>
          {error && <div className="form-error">{error}</div>}
          {saved && <div className="bounty-note">Lineup saved.</div>}
          <button
            className="btn-primary dfs-save"
            type="button"
            disabled={busy || !complete}
            onClick={save}
          >
            {busy
              ? 'Saving…'
              : complete
                ? 'Save lineup'
                : left < 0
                  ? `${money(-left)} over the cap`
                  : `${lineup.length - filled} slot(s) to fill`}
          </button>
        </>
      )}

      {picking != null && (
        <div className="picker-backdrop" role="dialog" aria-modal="true">
          <div className="picker dfs-picker">
            <div className="picker-head">
              <div>
                <div className="picker-title">
                  {lineup[picking] === 'FLEX' ? 'FLEX — RB, WR or TE' : lineup[picking]}
                </div>
                <div className="dim">
                  {money(Math.max(0, budgetFor))} to spend here and still fill the rest
                </div>
              </div>
            </div>

            {/* The whole reason this is usable on a phone. */}
            <input
              className="field dfs-search"
              type="search"
              inputMode="search"
              placeholder="Search name or team…"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />

            <div className="dfs-candidates">
              {candidates.length === 0 ? (
                <div className="empty">Nobody matches that.</div>
              ) : (
                candidates.slice(0, 60).map((p) => {
                  const tooDear = Number(p.salary) > budgetFor;
                  return (
                    <button
                      key={p.player_id}
                      type="button"
                      className={`dfs-candidate ${tooDear ? 'dfs-candidate-dear' : ''}`}
                      disabled={tooDear}
                      onClick={() => choose(p)}
                    >
                      <PlayerPhoto
                        src={photo(p)}
                        name={p.name}
                        position={p.position}
                        size={30}
                      />
                      <span className="dfs-slot-main">
                        <span className="dfs-slot-name">{p.name}</span>
                        <span className="dim">
                          {p.position} · {p.nfl_team ?? '—'} · {p.projection.toFixed(1)} proj
                        </span>
                      </span>
                      <span className="dfs-slot-cost">{money(p.salary)}</span>
                    </button>
                  );
                })
              )}
              {candidates.length > 60 && (
                <div className="dim dfs-more">
                  {candidates.length - 60} more — keep typing to narrow it.
                </div>
              )}
            </div>

            <button
              className="btn-ghost"
              type="button"
              onClick={() => {
                setPicking(null);
                setQuery('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
