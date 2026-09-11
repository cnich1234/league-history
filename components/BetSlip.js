'use client';

import { useState } from 'react';
import { useSlip } from './SlipProvider';

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
/**
 * What to promise about closing time.
 *
 * This used to say "Closes Wed night", derived from locks_at minus a day. That
 * was never a real deadline: a prop closes at its player's kickoff, and a live
 * market does not close on the clock at all -- it reprices until the result is
 * decided. Naming a night that nothing actually happens on is worse than saying
 * the real rule.
 */
function lockLabel(market) {
  if (market.live) return 'Open · prices move live';
  const day = new Date(market.locks_at).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `Closes at ${day} kickoff`;
}

export default function BetSlip({
  market,
  existingBet,
  // Legs of YOUR parlays that sit on this market. A parlay has no market_id of
  // its own, so without this a market you had already backed inside a slip
  // looked exactly like one you had never touched.
  parlayLegs,
  disabled,
  bankrollCents,
  livePrices,
}) {
  const slip = useSlip();
  const [selected, setSelected] = useState(null);
  const [stake, setStake] = useState('25');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(existingBet ?? null);
  // Bets cannot be cancelled, so an accidental tap is permanent. Review is a
  // separate step with the confirm button in a different place, so muscle
  // memory from tapping "Review" cannot carry through to confirming.
  const [reviewing, setReviewing] = useState(false);

  // A live market keeps taking bets after its posted lock, at a price that
  // moves with the game. It only truly closes when the model suspends it.
  //
  // `locked` is the server's status, never the clock. A prop's locks_at is
  // midnight on the morning of the game, so greying out on that showed a bet as
  // closed while its game was still hours away.
  const pastLock = market.locks_at != null && new Date(market.locks_at) <= new Date();
  const locked = market.status != null && market.status !== 'open';
  const liveNow = pastLock && market.live && livePrices != null;
  const liveShut = pastLock && market.live && livePrices == null;
  // `disabled` is what a guest gets: the prices are worth reading, but a tap
  // that ends in "Guests cannot place bets" is a worse answer than a control
  // that never invited the tap.
  const shut = disabled || locked || liveShut;
  const stakeNum = Number(stake);
  // A live market caps lower as it approaches being decided. Display only --
  // the server recomputes and enforces it, since this component is editable.
  const cap = liveNow && livePrices?.maxStakeCents != null ? livePrices.maxStakeCents / 100 : MAX;
  const capped = cap < MAX;
  // A market already in the parlay slip cannot also be bet straight -- offering
  // both is what let someone pay for a single and a parlay leg on one tap each.
  const inSlip = slip.has(market.id);
  const valid =
    Number.isFinite(stakeNum) &&
    stakeNum >= MIN &&
    stakeNum <= cap &&
    stakeNum * 100 <= bankrollCents;

  async function place() {
    if (!selected || !valid || !reviewing) return;
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
          // What was on screen. The server prices the bet itself and refuses
          // if this has drifted, so a scoring play mid-tap cannot fill at a
          // number that no longer exists.
          expectedOdds: selected.odds,
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
      setReviewing(false);
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
    <div className={`market ${locked ? 'market-locked' : ''}`}>
      <div className="market-head">
        <span className="market-title">{market.title}</span>
        {market.subtitle && <span className="dim">{market.subtitle}</span>}
        {parlayLegs?.length > 0 && (
          <span className="market-mine">
            In your {parlayLegs.length > 1 ? `${parlayLegs.length} parlays` : 'parlay'} ·{' '}
            {parlayLegs.map((l) => l.option_label).join(', ')}
          </span>
        )}
        {market.locks_at && (
          <span
            className={
              liveNow
                ? 'market-lock market-lock-live'
                : locked || liveShut
                  ? 'market-lock market-lock-shut'
                  : 'market-lock'
            }
          >
            {liveNow
              ? capped
                ? `LIVE · max $${cap}`
                : 'LIVE · price moves'
              : locked || liveShut
                ? 'Closed'
                : lockLabel(market)}
          </span>
        )}
      </div>

      <div className="options">
        {market.options.map((raw) => {
          const o =
            liveNow && livePrices?.[raw.option_key] != null
              ? { ...raw, odds: livePrices[raw.option_key] }
              : raw;
          return (
          <button
            key={o.option_key}
            type="button"
            className={`option ${
              selected?.option_key === o.option_key || slip.selected(market.id, o.option_key)
                ? 'option-on'
                : ''
            }`}
            onClick={() => {
              setReviewing(false);
              setError(null);
              setSelected(selected?.option_key === o.option_key ? null : o);
            }}
            disabled={shut}
          >
            <span className="option-label">{o.label}</span>
            <span className="option-odds">{o.odds > 0 ? `+${o.odds}` : o.odds}</span>
          </button>
          );
        })}
      </div>

      {selected && !shut && reviewing && (
        <div className="confirm">
          <div className="confirm-head">Confirm your bet</div>
          <dl className="confirm-rows">
            <div>
              <dt>Pick</dt>
              <dd>{selected.label}</dd>
            </div>
            <div>
              <dt>Market</dt>
              <dd>{market.title}</dd>
            </div>
            <div>
              <dt>Odds</dt>
              <dd>{selected.odds > 0 ? `+${selected.odds}` : selected.odds}</dd>
            </div>
            <div>
              <dt>Stake</dt>
              <dd>{money(stakeNum)}</dd>
            </div>
            <div className="confirm-total">
              <dt>Returns if it wins</dt>
              <dd>{money(payout(stakeNum, selected.odds))}</dd>
            </div>
          </dl>
          <p className="confirm-warning">Bets cannot be changed or cancelled.</p>
          <div className="confirm-actions">
            <button className="btn-ghost" type="button" onClick={() => setReviewing(false)}>
              Back
            </button>
            <button className="btn-primary btn-sm" onClick={place} disabled={busy}>
              {busy ? 'Placing…' : 'Confirm bet'}
            </button>
          </div>
        </div>
      )}

      {selected && !shut && !reviewing && inSlip && (
        <div className="in-slip-note">
          <span>
            In your parlay slip. <strong>Place it from the slip at the bottom.</strong>
          </span>
          <button
            className="btn-ghost"
            type="button"
            onClick={() => slip.remove(market.id)}
          >
            Remove
          </button>
        </div>
      )}

      {selected && !shut && !reviewing && !inSlip && (
        <div className="stake-row">
          <div className="stake-input">
            <span className="stake-prefix">$</span>
            <input
              type="number"
              inputMode="decimal"
              min={MIN}
              max={cap}
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
            ) : capped && stakeNum > cap ? (
              <span className="neg">Max ${cap} — this one is close to decided</span>
            ) : (
              <span className="neg">
                ${MIN}–${cap}
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
          <button
            className="btn-parlay"
            type="button"
            onClick={() =>
              slip.toggle({
                marketId: market.id,
                optionKey: selected.option_key,
                odds: selected.odds,
                label: selected.label,
                marketTitle: market.title,
              })
            }
          >
            + Parlay
          </button>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
