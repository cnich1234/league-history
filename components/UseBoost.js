'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
const odds = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * Uses one boost, picking a target first when it needs one.
 *
 * Some boosts need a choice and some do not, so the flow branches on what the
 * server says rather than on a hardcoded list here: the picker asks
 * /api/shop/targets what is legal right now, and shows exactly that. Ineligible
 * targets are still listed, greyed, with the reason -- "already has Insurance"
 * is more useful than an item silently missing from a list.
 *
 * Using a boost is irreversible, so the chosen target is confirmed before it
 * fires. Buying is not confirmed; using is.
 */
// Boosts with nothing to choose. Kept here rather than read from the boost
// definition because lib/boosts.js pulls in server-only code.
const NO_TARGET = new Set(['boost-week', 'ghost']);

const DESCRIPTIONS = {
  ghost:
    'Go dark for this week? Your bets vanish from The Action, so nobody can attack what they cannot see.',
  'boost-week':
    'Declare Big Week? Every bet you win this week pays 50% more. If nothing wins, it is gone.',
};

export default function UseBoost({ boost, label, week }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function openPicker() {
    setOpen(true);
    setError(null);
    setChosen(null);
    setTargets(null);
    try {
      const res = await fetch(`/api/shop/targets?kind=${encodeURIComponent(boost.kind)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not load targets.');
      setTargets(data);
    } catch (err) {
      setError(err.message);
      setTargets({ targets: [] });
    }
  }

  /**
   * Uses a boost that has no target.
   *
   * Confirmed first, because it is still irreversible: Better Price is spent by
   * whatever you bet next, and Big Week is locked to the week you declare it
   * for. Neither can be taken back.
   */
  async function activate() {
    const def = DESCRIPTIONS[boost.kind];
    if (!window.confirm(def ?? `Use ${boost.name}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const body = { action: 'use', boostId: boost.id };
      if (boost.kind === 'boost-week' || boost.kind === 'ghost') body.week = week;
      const res = await fetch('/api/shop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not use that.');
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function use() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const body = { action: 'use', boostId: boost.id, kind: boost.kind };
      if (targets.target === 'market') body.marketId = chosen.id;
      // A boost aimed at a PERSON sends a slug and a week, not a bet id. This
      // fell through to betId, so even once the picker listed managers the
      // server had nothing to act on.
      else if (targets.target === 'bettor') {
        body.target = chosen.id;
        body.week = targets.week;
      } else body.betId = chosen.id;

      const res = await fetch('/api/shop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not use that.');

      // A Receipt answers a question rather than changing anything, so the
      // answer has to be shown before the dialog closes.
      if (data.attackers) {
        window.alert(
          data.attackers.length === 0
            ? 'Nobody has touched that bet.'
            : data.attackers
                .map((a) => `${a.icon} ${a.name} — ${a.who}`)
                .join(String.fromCharCode(10)),
        );
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Boosts that need no target: Better Price arms and waits for your next bet,
  // Big Week covers the whole week. Opening a picker for them showed "Nothing
  // to use this on right now", which reads as broken rather than as "there is
  // nothing to choose".
  const needsTarget = !NO_TARGET.has(boost.kind);

  if (!open) {
    return (
      <>
        <button
          className="boost-use"
          type="button"
          onClick={needsTarget ? openPicker : activate}
          disabled={busy}
        >
          {busy ? 'Working…' : label ?? (needsTarget ? 'Use' : 'Activate')}
        </button>
        {error && <div className="form-error">{error}</div>}
      </>
    );
  }

  const list = targets?.targets ?? [];
  const usable = list.filter((t) => t.eligible);

  return (
    <div className="picker-backdrop" role="dialog" aria-modal="true">
      <div className="picker">
        <div className="picker-head">
          <span className="picker-icon" aria-hidden="true">
            {boost.icon}
          </span>
          <div>
            <div className="picker-title">{boost.name}</div>
            <div className="dim">{boost.blurb}</div>
          </div>
        </div>

        {targets == null && <div className="empty">Loading…</div>}

        {targets != null && list.length === 0 && (
          <div className="empty">{error ?? 'Nothing to use this on right now.'}</div>
        )}

        {list.length > 0 && (
          <>
            {usable.length === 0 && (
              <div className="picker-note">
                Nothing is eligible right now — here is why.
              </div>
            )}
            <div className="picker-list">
              {list.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`picker-item ${chosen?.id === t.id ? 'picker-item-on' : ''}`}
                  disabled={!t.eligible}
                  onClick={() => setChosen(t)}
                >
                  <span className="picker-item-main">
                    <span className="picker-item-title">{t.title}</span>
                    <span className="dim">
                      {t.subtitle}
                      {t.stakeCents != null && (
                        <>
                          {t.subtitle ? ' · ' : ''}
                          {money(t.stakeCents)} at {odds(t.odds)}
                        </>
                      )}
                      {!t.eligible && t.why && (
                        <>
                          {t.subtitle || t.stakeCents != null ? ' · ' : ''}
                          {t.why}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {error && list.length > 0 && <div className="form-error">{error}</div>}

        <div className="picker-actions">
          <button
            className="picker-cancel"
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="picker-go" type="button" onClick={use} disabled={busy || !chosen}>
            {busy ? 'Working…' : chosen ? `Use on ${chosen.title}` : 'Pick one'}
          </button>
        </div>
      </div>
    </div>
  );
}
