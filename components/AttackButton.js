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
export default function AttackButton({
  betId,
  who,
  attacks,
  catalogue = [],
  shielded = false,
  // Already carries an attack. One per bet, so there is nothing to fire.
  spent = false,
  // Ride Along boosts you own. Not attacks -- they copy the bet rather than
  // hurting it -- so a shield does not block them and a hit bet still takes one.
  rides = [],
  stakeCents = 0,
  // Whether the bet's market is still open. An attack lands on a locked
  // market; a copy cannot, because the pick is public on The Floor by then.
  rideable = true,
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The weapon awaiting confirmation. The panel swaps to a confirm step rather
  // than raising a browser alert -- an alert sits outside the app styling and
  // cannot show the blurb properly.
  const [confirming, setConfirming] = useState(null);

  async function fire(attack) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `kind` is what routes a Ride Along to the copy path rather than the
        // attack path on the server.
        body: JSON.stringify({ action: 'use', boostId: attack.id, betId, kind: attack.kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not use that.');
      setConfirming(null);
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // A ride you own is only an option while the game has not started.
  const canRide = rides.length > 0 && rideable;

  if (spent && !canRide) {
    return (
      <span className="attack-spent" title="One attack per bet">
        Hit
      </span>
    );
  }

  if (!open) {
    return (
      <button className="attack-btn" type="button" onClick={() => setOpen(true)}>
        {spent ? 'Ride' : 'Attack'}
      </button>
    );
  }

  const isRide = Boolean(confirming?.copies);
  // A hit bet takes no second attack; only the rides are offered on it.
  const weapons = spent ? [] : attacks;

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

        {confirming ? (
          <div className="picker-confirm">
            <div className="picker-confirm-head">
              {confirming.icon} {confirming.name} {isRide ? 'with' : 'on'} {who}&apos;s bet?
            </div>
            <p className="dim">{confirming.blurb}</p>
            <p className="confirm-warning">
              {isRide
                ? `You copy it at their stake -- $${(stakeCents / 100).toFixed(2)} out of this week -- ` +
                  'without seeing the pick. They keep their bet; you win or lose together.'
                : 'You cannot see what they backed, and this cannot be undone.'}
            </p>
            {error && <div className="form-error">{error}</div>}
            <div className="confirm-actions">
              <button
                className="btn-ghost"
                type="button"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                Back
              </button>
              <button
                className="btn-primary btn-sm"
                type="button"
                disabled={busy}
                onClick={() => fire(confirming)}
              >
                {busy ? 'Firing…' : 'Do it'}
              </button>
            </div>
          </div>
        ) : weapons.length > 0 || rides.length > 0 ? (
          <div className="picker-list">
            {weapons.map((a) => (
              <button
                key={a.id}
                type="button"
                className="picker-item"
                disabled={busy || shielded}
                onClick={() => setConfirming(a)}
              >
                <span className="picker-item-main">
                  <span className="picker-item-title">
                    {a.icon} {a.name}
                  </span>
                  <span className="dim">{a.blurb}</span>
                </span>
              </button>
            ))}
            {rides.map((r) => (
              <button
                key={r.id}
                type="button"
                className="picker-item"
                disabled={busy || !rideable}
                onClick={() => setConfirming({ ...r, copies: true })}
              >
                <span className="picker-item-main">
                  <span className="picker-item-title">
                    {r.icon} {r.name}
                  </span>
                  <span className="dim">
                    {rideable ? r.blurb : 'Its game has started -- too late to copy it.'}
                  </span>
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

        {/* The confirm step shows its own copy of this. */}
        {error && !confirming && <div className="form-error">{error}</div>}

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
