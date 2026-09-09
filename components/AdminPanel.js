'use client';

import { useState } from 'react';

const money = (cents) =>
  `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AdminPanel({ bettors, buyins, season, pool }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);

  async function call(url, body, label) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed.');
      window.location.reload();
    } catch (e) {
      setMessage({ error: e.message });
      setBusy(null);
    }
  }

  return (
    <>
      <section className="section">
        <div className="section-head">
          <h2>Prize pool</h2>
        </div>
        <div className="bankroll-card">
          <div>
            <div className="dim">Collected</div>
            <div className="bankroll-amount">{money(pool.totalCents)}</div>
          </div>
          <div className="bankroll-record">
            {money(pool.baseCents)} base
            {pool.buyinsCollected > 0 && (
              <>
                <br />+{pool.buyinsCollected} re-up{pool.buyinsCollected === 1 ? '' : 's'}
              </>
            )}
            {pool.outstandingCents > 0 && (
              <>
                <br />
                <span className="neg">{money(pool.outstandingCents)} owed</span>
              </>
            )}
          </div>
        </div>
      </section>

      {message?.error && <div className="form-error">{message.error}</div>}

      <section className="section">
        <div className="section-head">
          <h2>Managers</h2>
          <span className="dim">re-up = $20 in, $1000 bankroll</span>
        </div>
        <div className="rows">
          {bettors.map((b) => (
            <div key={b.slug} className="row">
              <span className="row-main">
                <span className="row-name">{b.display_name}</span>
                <span className="dim">
                  {money(b.balance_cents)}
                  {!b.has_password && ' · not signed up yet'}
                </span>
              </span>
              <span className="admin-actions">
                <button
                  className="btn-ghost"
                  disabled={busy !== null || !b.has_password}
                  onClick={() => {
                    if (confirm(`Reset ${b.display_name}'s password? They will set a new one next sign-in.`)) {
                      call('/api/admin/reset', { slug: b.slug }, `reset-${b.slug}`);
                    }
                  }}
                >
                  {busy === `reset-${b.slug}` ? '…' : 'Reset pw'}
                </button>
                <button
                  className="btn-ghost btn-ghost-on"
                  disabled={busy !== null}
                  onClick={() => {
                    if (confirm(`Re-up ${b.display_name} for $20? Adds $1000 to their bankroll.`)) {
                      call('/api/admin/buyin', { slug: b.slug, season }, `buyin-${b.slug}`);
                    }
                  }}
                >
                  {busy === `buyin-${b.slug}` ? '…' : 'Re-up'}
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Re-ups</h2>
          <span className="dim">{buyins.length} this season</span>
        </div>
        {buyins.length === 0 ? (
          <div className="empty">Nobody has gone broke yet.</div>
        ) : (
          <div className="rows">
            {buyins.map((b) => (
              <div key={b.id} className="row">
                <span className="row-main">
                  <span className="row-name">{b.display_name}</span>
                  <span className="dim">
                    {money(b.amount_cents)} owed ·{' '}
                    {new Date(b.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {b.note && ` · ${b.note}`}
                  </span>
                </span>
                <button
                  className={`btn-ghost ${b.collected ? 'btn-ghost-paid' : ''}`}
                  disabled={busy !== null}
                  onClick={() =>
                    call(
                      '/api/admin/buyin',
                      { action: 'collect', id: b.id, collected: !b.collected },
                      `collect-${b.id}`,
                    )
                  }
                >
                  {busy === `collect-${b.id}` ? '…' : b.collected ? 'Paid ✓' : 'Mark paid'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
