'use client';

import { useState } from 'react';
import { useSlip } from './SlipProvider';
import { boostOdds } from '@/lib/boosts';

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
  const day = new Date(market.locks_at).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  // A live market that has NOT reached its lock yet said "Open · prices move
  // live", which sat one line away from "LIVE · price moves" on a market that
  // genuinely was live -- two near-identical phrases for opposite states. Say
  // when it starts moving instead, since that is the thing you cannot see.
  if (market.live) return `Live from ${day}`;
  return `Closes at ${day} kickoff`;
}

export default function BetSlip({
  market,
  existingBet,
  // Unused Better Price boosts. Offered here rather than armed in advance, so
  // you choose the bet AND see what it does to the price before committing.
  oddsBoosts = [],
  // Insurance and Half Again, offered at the moment of betting rather than
  // making people find the bet again in My Boosts afterwards.
  slipBoosts = [],
  // Legs of YOUR parlays that sit on this market. A parlay has no market_id of
  // its own, so without this a market you had already backed inside a slip
  // looked exactly like one you had never touched.
  parlayLegs,
  disabled,
  bankrollCents,
  livePrices,
  // A pending Slow Play against you: { minStakeDollars }. Shown rather than
  // sprung, now that it cannot be dodged with a cheap bet -- a stake that
  // silently costs double reads as a bug rather than an attack.
  slowed = null,
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
  const [useBoost, setUseBoost] = useState(false);
  const [attach, setAttach] = useState({});

  // A live market keeps taking bets after its posted lock, at a price that
  // moves with the game. It only truly closes when the model suspends it.
  //
  // `locked` is the server's status, never the clock. A prop's locks_at is
  // midnight on the morning of the game, so greying out on that showed a bet as
  // closed while its game was still hours away.
  const pastLock = market.locks_at != null && new Date(market.locks_at) <= new Date();
  // Within a day of closing. Only then is the deadline worth shouting about.
  const closingToday =
    market.locks_at != null &&
    !pastLock &&
    new Date(market.locks_at) - new Date() < 24 * 60 * 60 * 1000;
  const locked = market.status != null && market.status !== 'open';
  const liveNow = pastLock && market.live && livePrices != null;
  const liveShut = pastLock && market.live && livePrices == null;
  // `disabled` is what a guest gets: the prices are worth reading, but a tap
  // that ends in "Guests cannot place bets" is a worse answer than a control
  // that never invited the tap.
  const shut = disabled || locked || liveShut;
  const stakeNum = Number(stake);

  // What the bet would actually be placed at. Boosting multiplies the PROFIT,
  // not the payout, so +200 becomes +300 rather than +450 -- worth seeing
  // before you commit rather than discovering afterwards.
  const boostAvailable = oddsBoosts.length > 0;
  // Better Price has its own control above -- it changes the displayed price,
  // so it cannot be a plain tick-box like the others.
  const extras = slipBoosts.filter((b) => b.kind !== 'odds-boost');
  const boosting = boostAvailable && useBoost;
  const effectiveOdds = selected
    ? boosting
      ? boostOdds(selected.odds)
      : selected.odds
    : null;
  // A live market caps lower as it approaches being decided. Display only --
  // the server recomputes and enforces it, since this component is editable.
  const cap = liveNow && livePrices?.maxStakeCents != null ? livePrices.maxStakeCents / 100 : MAX;
  const capped = cap < MAX;
  // A market already in the parlay slip cannot also be bet straight -- offering
  // both is what let someone pay for a single and a parlay leg on one tap each.
  const inSlip = slip.has(market.id);

  // A slowed bet only doubles once it reaches the floor -- below that it is
  // charged normally and the slow keeps waiting.
  const slowDoubles = Boolean(slowed) && stakeNum >= (slowed.minStakeDollars ?? Infinity);
  // What leaves the allowance, which is what the week has to cover. Checking
  // the nominal stake would let someone through Review on a bet the server
  // then refuses for want of funds.
  const costNum = slowDoubles ? stakeNum * 2 : stakeNum;

  const valid =
    Number.isFinite(stakeNum) &&
    stakeNum >= MIN &&
    stakeNum <= cap &&
    costNum * 100 <= bankrollCents;

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
          // Which boost to spend, if any. The server re-prices from this rather
          // than trusting the number above.
          oddsBoostId: boosting ? oddsBoosts[0].id : null,
          attachBoostIds: extras.filter((b) => attach[b.kind]).map((b) => b.id),
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
                  : closingToday
                    ? 'market-lock market-lock-soon'
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
              <dd>
                {boosting ? (
                  <>
                    <span className="dim strike">
                      {selected.odds > 0 ? `+${selected.odds}` : selected.odds}
                    </span>{' '}
                    <strong className="boosted">
                      {effectiveOdds > 0 ? `+${effectiveOdds}` : effectiveOdds}
                    </strong>
                  </>
                ) : selected.odds > 0 ? (
                  `+${selected.odds}`
                ) : (
                  selected.odds
                )}
              </dd>
            </div>
            <div>
              <dt>Stake</dt>
              <dd>{money(stakeNum)}</dd>
            </div>
            {slowDoubles && (
              <div>
                <dt>🐌 Costs you</dt>
                <dd className="neg">{money(stakeNum * 2)}</dd>
              </div>
            )}
            <div className="confirm-total">
              <dt>Returns if it wins</dt>
              <dd>{money(payout(stakeNum, effectiveOdds))}</dd>
            </div>
          </dl>
          {slowDoubles && (
            <p className="confirm-warning">
              You have been slowed: this comes out of your allowance twice. The bet itself
              is the size you asked for, and this wears the slow off.
            </p>
          )}
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

      {/* Offered only when you own one and have picked a side, so it appears at
          the moment the decision is actually being made. */}
      {selected && !shut && !reviewing && !inSlip && boostAvailable && (
        <label className="boost-offer">
          <input
            type="checkbox"
            checked={useBoost}
            onChange={(e) => setUseBoost(e.target.checked)}
          />
          <span>
            ⚡ Use <strong>Better Price</strong>
            {useBoost ? (
              <>
                {' '}
                — {selected.odds > 0 ? `+${selected.odds}` : selected.odds} becomes{' '}
                <strong className="boosted">
                  {effectiveOdds > 0 ? `+${effectiveOdds}` : effectiveOdds}
                </strong>
              </>
            ) : (
              <span className="dim"> — 50% better odds on this bet</span>
            )}
          </span>
        </label>
      )}

      {/* Everything else that can go on a bet at the moment it is placed. Same
          row as Better Price, because the decision is the same decision. */}
      {selected &&
        !shut &&
        !reviewing &&
        !inSlip &&
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
                returns <strong>{money(payout(stakeNum, effectiveOdds))}</strong>
                {slowDoubles && (
                  <span className="neg"> · costs {money(stakeNum * 2)} 🐌</span>
                )}
              </>
            ) : costNum * 100 > bankrollCents ? (
              <span className="neg">
                {slowDoubles ? `Slowed — ${money(costNum)} is more than your week` : 'More than your bankroll'}
              </span>
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
