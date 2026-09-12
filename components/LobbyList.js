'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Open lobbies, and the form to start one.
 *
 * A lobby is the recycled half of daily fantasy: buy-ins are escrowed, pooled,
 * and the winner takes the lot. Nothing is minted, which is why the buy-in can
 * be anything -- no amount of it can inflate the economy.
 */
export default function LobbyList({ lobbies, week, points, me, cap }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [seats, setSeats] = useState('4');
  const [buyin, setBuyin] = useState('5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const seatsN = Number(seats);
  const buyinN = Number(buyin);
  const valid =
    Number.isInteger(seatsN) &&
    seatsN >= 2 &&
    seatsN <= 10 &&
    Number.isInteger(buyinN) &&
    buyinN >= 1 &&
    buyinN <= points;

  async function create() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dfs/lobby', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week, name, seats: seatsN, buyinPoints: buyinN }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not open that.');
      setOpen(false);
      setName('');
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
        <h2>Lobbies</h2>
        <span className="dim">{lobbies.length} open</span>
      </div>

      {lobbies.length === 0 ? (
        <div className="empty">Nobody has opened one. Points here are recycled, not minted.</div>
      ) : (
        <div className="dfs-lobbies">
          {lobbies.map((l) => {
            const full = l.seats_taken >= l.seats;
            const mine = l.entered;
            return (
              <a key={l.id} className="dfs-lobby" href={`/dfs/lobby/${l.id}`}>
                <span className="dfs-lobby-main">
                  <span className="dfs-lobby-name">
                    {l.name || `${l.host_name}'s lobby`}
                    {mine && <span className="pill teal dfs-lobby-in">in</span>}
                  </span>
                  <span className="dim">
                    {l.seats_taken}/{l.seats} seats · {l.buyin_points} to enter · by{' '}
                    {l.host_name}
                  </span>
                </span>
                <span className="dfs-lobby-pot">
                  <span className="dfs-lobby-pot-n">{l.pot}</span>
                  <span className="dim">{full ? 'full' : 'pot'}</span>
                </span>
              </a>
            );
          })}
        </div>
      )}

      {!open ? (
        <button className="bounty-post" type="button" onClick={() => setOpen(true)}>
          ⚡ Open a lobby
        </button>
      ) : (
        <div className="bounty-form">
          <label className="field-label">
            Name it (optional)
            <input
              className="field"
              value={name}
              maxLength={40}
              placeholder="Friday night special"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="dfs-lobby-fields">
            <label className="field-label">
              Seats
              <input
                className="field"
                type="number"
                inputMode="numeric"
                min={2}
                max={10}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
              />
            </label>
            <label className="field-label">
              Buy-in
              <input
                className="field"
                type="number"
                inputMode="numeric"
                min={1}
                max={points}
                value={buyin}
                onChange={(e) => setBuyin(e.target.value)}
              />
            </label>
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="confirm-actions">
            <button className="btn-ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary btn-sm"
              type="button"
              onClick={create}
              disabled={busy || !valid}
            >
              {busy ? 'Opening…' : 'Open it'}
            </button>
          </div>
          <p className="confirm-warning">
            You pay the buy-in when you enter a lineup, like everybody else. Winner takes
            the pot — {seatsN >= 2 && buyinN >= 1 ? `${seatsN * buyinN} if it fills` : 'the lot'}.
            If it never fills, everyone gets their points back.
          </p>
        </div>
      )}
    </section>
  );
}
