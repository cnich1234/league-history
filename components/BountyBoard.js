'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Open bounties, and the form to post one.
 *
 * A bounty is not a boost -- it buys nothing for the person posting it. It pays
 * somebody ELSE to act, which makes it the only thing in the app where one
 * manager's move is worth money to another.
 *
 * Deliberately loud. The whole value is that everyone sees it: the target knows
 * to defend, and everyone else knows there are points on the table.
 */
export default function BountyBoard({ bounties, managers, attacks, points, week }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [weapon, setWeapon] = useState('');
  const [reward, setReward] = useState('10');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const rewardNum = Number(reward);
  const valid =
    target && weapon && Number.isFinite(rewardNum) && rewardNum >= 1 && rewardNum <= points;

  async function post() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bounty', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, weapon, rewardPoints: rewardNum, week }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not post that.');
      setOpen(false);
      setTarget('');
      setWeapon('');
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <h2>Bounties</h2>
        <span className="dim">{bounties.length} open</span>
      </div>

      {bounties.length > 0 && (
        <div className="bounty-list">
          {bounties.map((b) => (
            <div key={b.id} className="bounty-alert">
              <div className="bounty-head">BOUNTY ALERT</div>
              <div className="bounty-body">
                A bounty has been placed on{' '}
                <strong>{b.target_name.toUpperCase()}</strong>
                <br />
                <span className="dim">ATTACK:</span> <strong>{b.weaponName}</strong>
                <br />
                <span className="dim">REWARD:</span>{' '}
                <strong className="bounty-reward">{b.reward_points} Points</strong>
              </div>
              <div className="dim bounty-poster">posted by {b.poster_name}</div>
            </div>
          ))}
        </div>
      )}

      {!open ? (
        <button className="bounty-post" type="button" onClick={() => setOpen(true)}>
          Put points on someone
        </button>
      ) : (
        <div className="bounty-form">
          <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Who?</option>
            {managers.map((m) => (
              <option key={m.slug} value={m.slug}>
                {m.display_name}
              </option>
            ))}
          </select>

          <select className="field" value={weapon} onChange={(e) => setWeapon(e.target.value)}>
            <option value="">Which attack?</option>
            {attacks.map((a) => (
              <option key={a.kind} value={a.kind}>
                {a.icon} {a.name}
              </option>
            ))}
          </select>

          <div className="stake-input">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={points}
              value={reward}
              onChange={(e) => setReward(e.target.value)}
              aria-label="Reward in points"
            />
            <span className="dim">of {points} points</span>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="confirm-actions">
            <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary btn-sm" type="button" onClick={post} disabled={busy || !valid}>
              {busy ? 'Posting…' : 'Post bounty'}
            </button>
          </div>
          <p className="confirm-warning">
            The points leave your balance now. If nobody claims it this week, you get them
            back.
          </p>
        </div>
      )}
    </section>
  );
}
