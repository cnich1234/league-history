'use client';

import { useState } from 'react';
import { useSlip } from './SlipProvider';
import { MIN_STAKE_CENTS, MAX_STAKE_CENTS } from '@/lib/odds';

const MIN = MIN_STAKE_CENTS / 100;
const MAX = MAX_STAKE_CENTS / 100;
const MIN_LEGS = 2;
const MAX_LEGS = 6;

/** Mirrors lib/odds.js. Display only -- the server re-prices everything. */
function americanToDecimal(odds) {
  return odds > 0 ? odds / 100 + 1 : 100 / Math.abs(odds) + 1;
}
function combine(legOdds) {
  if (!legOdds.length) return null;
  const decimal = legOdds.reduce((acc, o) => acc * americanToDecimal(o), 1);
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}
function payout(stake, odds) {
  return stake + profitOf(stake, odds);
}
/** What banks on a win. The stake is consumed either way. */
function profitOf(stake, odds) {
  return odds > 0 ? (stake * odds) / 100 : (stake * 100) / Math.abs(odds);
}
const money = (n) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtOdds = (o) => (o > 0 ? `+${o}` : String(o));

/**
 * The floating slip. Appears once two legs are selected.
 *
 * Fixed to the bottom above the nav so it is reachable without scrolling back
 * up, which matters when the legs are spread across five matchup cards.
 */
export default function ParlaySlip({ bankrollCents, slipBoosts = [] }) {
  const { legs, remove, clear } = useSlip();
  const [stake, setStake] = useState('25');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Same reasoning as a straight bet: a parlay cannot be cancelled, and the
  // stakes are higher because it is several legs at once.
  const [reviewing, setReviewing] = useState(false);
  const [attach, setAttach] = useState({});

  // Insurance, Half Again and Mirror: chosen here or not at all, same as a
  // straight bet. Better Price and Lock In are per-market and do not apply.
  const extras = slipBoosts.filter((b) => !['odds-boost', 'lock-in'].includes(b.kind));

  if (legs.length === 0) return null;

  const odds = combine(legs.map((l) => l.odds));
  const stakeNum = Number(stake);
  const enough = legs.length >= MIN_LEGS;
  const tooMany = legs.length > MAX_LEGS;
  const valid =
    enough &&
    !tooMany &&
    Number.isFinite(stakeNum) &&
    stakeNum >= MIN &&
    stakeNum <= MAX &&
    stakeNum * 100 <= bankrollCents;

  async function place() {
    if (!valid || !reviewing) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/parlay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stakeDollars: stakeNum,
          legs: legs.map((l) => ({ marketId: l.marketId, optionKey: l.optionKey })),
          attachBoostIds: extras.filter((b) => attach[b.kind]).map((b) => b.id),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not place parlay.');
      setReviewing(false);
      clear();
      window.location.reload();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className={`slip ${open ? 'slip-open' : ''}`}>
      <button className="slip-bar" onClick={() => setOpen(!open)} type="button">
        <span className="slip-count">{legs.length}</span>
        <span className="slip-summary">
          {legs.length === 1 ? 'Add another leg' : `${legs.length}-leg parlay`}
          {enough && odds != null && <span className="slip-odds"> {fmtOdds(odds)}</span>}
        </span>
        <span className={`slip-chevron ${open ? 'slip-chevron-up' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="slip-body">
          {legs.map((l) => (
            <div className="slip-leg" key={l.marketId}>
              <span className="slip-leg-main">
                <span className="slip-leg-pick">{l.label}</span>
                <span className="slip-leg-market">{l.marketTitle}</span>
              </span>
              <span className="slip-leg-odds">{fmtOdds(l.odds)}</span>
              <button
                className="slip-remove"
                onClick={() => remove(l.marketId)}
                aria-label={`Remove ${l.label}`}
                type="button"
              >
                ×
              </button>
            </div>
          ))}

          {!enough && <p className="slip-note">Pick at least one more leg.</p>}
          {tooMany && <p className="slip-note neg">Maximum {MAX_LEGS} legs.</p>}

          {enough && !tooMany && !reviewing &&
            extras.map((b) => (
              <label key={b.kind} className="boost-offer">
                <input
                  type="checkbox"
                  checked={Boolean(attach[b.kind])}
                  onChange={(e) => setAttach((a) => ({ ...a, [b.kind]: e.target.checked }))}
                />
                <span>
                  {b.icon} Use <strong>{b.name}</strong>
                  <span className="dim"> — {b.blurb}</span>
                </span>
              </label>
            ))}

          {enough && !tooMany && (
            <div className="slip-place">
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
                  aria-label="Parlay stake"
                />
              </div>
              <div className="stake-preview">
                {valid ? (
                  <>
                    returns <strong>{money(payout(stakeNum, odds))}</strong>
                    <span className="dim"> · +{money(profitOf(stakeNum, odds))} profit</span>
                  </>
                ) : stakeNum * 100 > bankrollCents ? (
                  <span className="neg">More than your bankroll</span>
                ) : (
                  <span className="neg">
                    ${MIN}–${MAX}
                  </span>
                )}
              </div>
              <button
                className="btn-primary btn-sm"
                onClick={() => setReviewing(true)}
                disabled={!valid}
              >
                Review
              </button>
            </div>
          )}

          {reviewing && (
            <div className="confirm">
              <div className="confirm-head">Confirm your parlay</div>
              <dl className="confirm-rows">
                <div>
                  <dt>Legs</dt>
                  <dd>{legs.length}, all must win</dd>
                </div>
                <div>
                  <dt>Odds</dt>
                  <dd>{fmtOdds(odds)}</dd>
                </div>
                <div>
                  <dt>Stake</dt>
                  <dd>{money(stakeNum)}</dd>
                </div>
                <div className="confirm-total">
                  <dt>Returns if it wins</dt>
                  <dd>{money(payout(stakeNum, odds))}</dd>
                </div>
                {extras.filter((b) => attach[b.kind]).length > 0 && (
                  <div>
                    <dt>With</dt>
                    <dd>{extras.filter((b) => attach[b.kind]).map((b) => `${b.icon} ${b.name}`).join(', ')}</dd>
                  </div>
                )}
              </dl>
              <p className="confirm-warning">Bets cannot be changed or cancelled.</p>
              <div className="confirm-actions">
                <button className="btn-ghost" type="button" onClick={() => setReviewing(false)}>
                  Back
                </button>
                <button className="btn-primary btn-sm" onClick={place} disabled={busy}>
                  {busy ? 'Placing…' : 'Confirm parlay'}
                </button>
              </div>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          {!reviewing && (
            <button className="slip-clear" onClick={clear} type="button">
              Clear slip
            </button>
          )}
        </div>
      )}
    </div>
  );
}
