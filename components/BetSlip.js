'use client';

import { useState } from 'react';

const MIN = 10;
const MAX = 250;

/** Total returned on a win, stake included. Mirrors lib/odds.js payoutCents. */
function payout(stake, odds) {
  const profit = odds > 0 ? (stake * odds) / 100 : (stake * 100) / Math.abs(odds);
  return stake + profit;
}

const money = (n) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One market, with its options and an inline stake entry.
 *
 * The payout preview is computed client-side purely for display. Every rule
 * that matters -- limits, bankroll, duplicate bets, lock time -- is re-checked
 * on the server, because this component is trivially editable in dev tools.
 */
export default function BetSlip({ market, existingBet, disabled, bankrollCents }) {
  const [selected, setSelected] = useState(null);
  const [stake, setStake] = useState('25');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(existingBet ?? null);

  const stakeNum = Number(stake);
  const valid =
    Number.isFinite(stakeNum) &&
    stakeNum >= MIN &&
    stakeNum <= MAX &&
    stakeNum * 100 <= bankrollCents;

  async function place() {
    if (!selected || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/bet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          marketId: market.id,
          optionKey: selected.option_key,
          stakeDollars: stakeNum,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not place bet.');
      setPlaced({
        option_label: selected.label,
        stake_cents: Math.round(stakeNum * 100),
        odds: selected.odds,
      });
      setSelected(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (placed) {
    return (
      <div className="market market-placed">
        <div className="market-head">
          <span className="market-title">{market.title}</span>
          <span className="pill pill-on">Bet placed</span>
        </div>
        <div className="dim">
          {placed.option_label} · {money(Number(placed.stake_cents) / 100)} at{' '}
          {placed.odds > 0 ? `+${placed.odds}` : placed.odds} · returns{' '}
          {money(payout(Number(placed.stake_cents) / 100, placed.odds))}
        </div>
      </div>
    );
  }

  return (
    <div className="market">
      <div className="market-head">
        <span className="market-title">{market.title}</span>
        {market.subtitle && <span className="dim">{market.subtitle}</span>}
      </div>

      <div className="options">
        {market.options.map((o) => (
          <button
            key={o.option_key}
            type="button"
            className={`option ${selected?.option_key === o.option_key ? 'option-on' : ''}`}
            onClick={() => setSelected(selected?.option_key === o.option_key ? null : o)}
            disabled={disabled}
          >
            <span className="option-label">{o.label}</span>
            <span className="option-odds">{o.odds > 0 ? `+${o.odds}` : o.odds}</span>
          </button>
        ))}
      </div>

      {selected && !disabled && (
        <div className="stake-row">
          <div className="stake-input">
            <span className="stake-prefix">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={MIN}
              max={MAX}
              step="5"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              aria-label="Stake"
            />
          </div>
          <div className="stake-preview">
            {valid ? (
              <>
                returns <strong>{money(payout(stakeNum, selected.odds))}</strong>
              </>
            ) : stakeNum * 100 > bankrollCents ? (
              <span className="neg">More than your bankroll</span>
            ) : (
              <span className="neg">
                ${MIN}–${MAX}
              </span>
            )}
          </div>
          <button className="btn-primary btn-sm" onClick={place} disabled={!valid || busy}>
            {busy ? '…' : 'Place'}
          </button>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
