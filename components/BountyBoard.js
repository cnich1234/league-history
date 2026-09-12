'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Open bounties, and the form to start one.
 *
 * A bounty is not a boost. Nobody buys anything: it names a target, a weapon and
 * a bet, costs exactly what that weapon costs in the shop, and anyone can put
 * points in. When the total is reached the attack fires by itself.
 *
 * That removes the pricing problem the first version had -- there is no hunter
 * buying at 12 to be paid 8 -- and it makes the expensive end of the catalogue
 * reachable: a 12-point Void is two and a half weeks of allowance alone, or two
 * points each if six people agree.
 *
 * Deliberately loud. The whole value is that everyone sees it: the target knows
 * to buy Insurance, and everybody else knows there are points on the table.
 */
export default function BountyBoard({
  bounties,
  bets,
  attacks,
  managers,
  points,
  week,
  me,
  stakes,
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [weapon, setWeapon] = useState('');
  const [betId, setBetId] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const def = attacks.find((a) => a.kind === weapon) ?? null;
  // Slow Play and Because, Fuck You hit a PERSON, so they need no bet. Every
  // other attack hits one bet, and the poster names which.
  const needsBet = def?.target === 'bet';
  const seed = def ? (stakes[def.kind] ?? 1) : 0;
  const chosen = bets.find((b) => String(b.id) === betId) ?? null;

  // Only other people's bets are worth aiming at.
  const theirs = bets.filter((b) => b.bettor !== me);
  const byOwner = {};
  for (const b of theirs) (byOwner[b.bettor_name] ??= []).push(b);

  const ready = Boolean(
    def && (needsBet ? chosen && !chosen.shielded : target) && points >= seed,
  );

  async function send(body, okNote) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/bounty', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'That did not work.');

      const fired = data.fired ?? data.bounty?.fired;
      if (fired?.fired) setNote('Funded — the attack just landed.');
      else if (fired?.refunded) setNote(`It could not land: ${fired.why}. Everyone refunded.`);
      else setNote(okNote);

      setOpen(false);
      setWeapon('');
      setBetId('');
      setTarget('');
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const post = () => {
    if (!ready) return;
    send(
      {
        week,
        weapon,
        target: needsBet ? chosen.bettor : target,
        betId: needsBet ? Number(betId) : null,
        points: seed,
      },
      'Bounty posted.',
    );
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2>Bounties</h2>
        <span className="dim">{bounties.length} open</span>
      </div>

      {note && <div className="bounty-note">{note}</div>}

      {bounties.length > 0 && (
        <div className="bounty-list">
          {bounties.map((b) => (
            <BountyCard
              key={b.id}
              bounty={b}
              points={points}
              me={me}
              busy={busy}
              onGive={(n) => send({ bountyId: Number(b.id), points: n }, 'Points in.')}
            />
          ))}
        </div>
      )}

      {!open ? (
        <button className="bounty-post" type="button" onClick={() => setOpen(true)}>
          🎯 Post Bounty
        </button>
      ) : (
        <div className="bounty-form">
          <label className="field-label">
            Which attack?
            <select className="field" value={weapon} onChange={(e) => setWeapon(e.target.value)}>
              <option value="">Pick one…</option>
              {attacks.map((a) => (
                <option key={a.kind} value={a.kind}>
                  {a.icon} {a.name} — {a.cost} points
                </option>
              ))}
            </select>
          </label>

          {def && (
            <p className="bounty-blurb">
              {def.blurb}{' '}
              <span className="dim">
                Costs {def.cost} in total — you start it with {seed}.
              </span>
            </p>
          )}

          {def && needsBet && (
            <label className="field-label">
              On which bet?
              <select className="field" value={betId} onChange={(e) => setBetId(e.target.value)}>
                <option value="">Pick a bet…</option>
                {Object.entries(byOwner).map(([owner, rows]) => (
                  <optgroup key={owner} label={owner}>
                    {rows.map((b) => (
                      <option key={b.id} value={String(b.id)} disabled={b.shielded > 0}>
                        {b.label}
                        {b.shielded > 0 ? ' — insured' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}

          {def && !needsBet && (
            <label className="field-label">
              On whom?
              <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Pick a manager…</option>
                {managers
                  .filter((m) => m.slug !== me)
                  .map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.display_name}
                    </option>
                  ))}
              </select>
            </label>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="confirm-actions">
            <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              type="button"
              onClick={post}
              disabled={busy || !ready}
            >
              {busy ? 'Posting…' : def ? `Post and put in ${seed}` : 'Post bounty'}
            </button>
          </div>
          {def && (
            <p className="confirm-warning">
              You put in <strong>{seed}</strong> to start it — 20% of {def.cost}. The rest has
              to come from other people. If nobody fills it by the end of the week, everyone
              gets their points back.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** One open bounty: who, what, how far along, and a way to chip in. */
function BountyCard({ bounty, points, me, busy, onGive }) {
  const pct = Math.min(100, Math.round((bounty.raised / bounty.cost_points) * 100));
  const mine = bounty.target === me;
  // The target cannot fund their own hanging, and nobody can give what they do
  // not have.
  const canGive = !mine && points > 0 && bounty.remaining > 0;

  // Condensed: four of these used to fill a phone screen. One line of who and
  // what, one line of bar, one row of buttons.
  return (
    <div className={`bounty-row ${mine ? 'bounty-row-mine' : ''}`}>
      <div className="bounty-row-top">
        <span className="bounty-row-who">
          {bounty.weaponName} on{' '}
          <strong>{mine ? 'YOU' : bounty.target_name.toUpperCase()}</strong>
        </span>
        <span className="bounty-reward">
          {bounty.raised}/{bounty.cost_points}
        </span>
      </div>

      <div
        className="bounty-bar"
        role="img"
        aria-label={`${bounty.raised} of ${bounty.cost_points} points raised`}
      >
        <div className="bounty-bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="bounty-row-foot">
        <span className="dim">
          {bounty.betShielded && (
            <span className="pill" title="This bet is insured" style={{ marginRight: 6 }}>
              🛡️
            </span>
          )}
          {bounty.betLabel ? `${bounty.betLabel} · ` : ''}
          {bounty.backers} backer{bounty.backers === 1 ? '' : 's'} · by {bounty.poster_name}
        </span>
        {canGive && (
          <span className="bounty-give">
            {[1, 5]
              .filter((n) => n <= bounty.remaining && n <= points)
              .map((n) => (
                <button key={n} type="button" disabled={busy} onClick={() => onGive(n)}>
                  +{n}
                </button>
              ))}
            {bounty.remaining <= points && (
              <button
                type="button"
                className="bounty-fill"
                disabled={busy}
                onClick={() => onGive(bounty.remaining)}
              >
                Fill ({bounty.remaining})
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
