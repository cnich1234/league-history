'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Fires one attack at one bet.
 *
 * The choice here is which WEAPON, not which target -- the target is the row
 * this button sits on. That is the reverse of every other boost, where you pick
 * the boost first and then hunt for something to use it on.
 *
 * Confirmed, because it is irreversible and because it is aimed at a person who
 * will find out.
 */
export default function AttackButton({ betId, who, attacks, catalogue = [], shielded = false }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function fire(attack) {
    if (!window.confirm(`${attack.name} on ${who}'s bet?\n\n${attack.blurb}\n\nYou cannot see what they backed, and this cannot be undone.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'use', boostId: attack.id, betId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not use that.');
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="attack-btn" type="button" onClick={() => setOpen(true)}>
        Attack
      </button>
    );
  }

  return (
    <div className="picker-backdrop" role="dialog" aria-modal="true">
      <div className="picker">
        <div className="picker-head">
          <span className="picker-icon" aria-hidden="true">
            {shielded ? '🛡️' : '🎯'}
          </span>
          <div>
            <div className="picker-title">Attack {who}</div>
            <div className="dim">
              {shielded
                ? 'This bet is insured. Nothing will get through.'
                : 'You cannot see what they backed.'}
            </div>
          </div>
        </div>

        {attacks.length > 0 ? (
          <div className="picker-list">
            {attacks.map((a) => (
              <button
                key={a.id}
                type="button"
                className="picker-item"
                disabled={busy || shielded}
                onClick={() => fire(a)}
              >
                <span className="picker-item-main">
                  <span className="picker-item-title">
                    {a.icon} {a.name}
                  </span>
                  <span className="dim">{a.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            {/* Owning nothing used to hide the button entirely, which made the
                page look like it had no actions. Show what could be bought
                instead. */}
            <div className="picker-note">
              You do not own any attacks. These are in the Store:
            </div>
            <div className="picker-list">
              {catalogue.map((a) => (
                <div key={a.kind} className="picker-item picker-item-flat">
                  <span className="picker-item-main">
                    <span className="picker-item-title">
                      {a.icon} {a.name}
                    </span>
                    <span className="dim">{a.blurb}</span>
                  </span>
                  <span className="picker-cost">{a.cost}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="picker-actions">
          <button
            className="picker-cancel"
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
