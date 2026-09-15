'use client';

import { useEffect, useState } from 'react';

const fmt = (n) => (Number(n) || 0).toFixed(2);

/**
 * Buy or sell one stock.
 *
 * Shows the ask and bid around the model price, what the order will cost or
 * pay in whole points (a buy rounds up, a sell rounds down), and queues the
 * order. Nothing fills on the tap: the next recorded tick fills it, within a
 * minute, at that tick's price. The sheet says so, because a price that moves
 * between tap and fill is the design, not a bug.
 */
export default function TradeSheet({ player, canTrade, onChanged }) {
  const [side, setSide] = useState('buy');
  const [shares, setShares] = useState(1);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [pending, setPending] = useState([]);

  const price = Number(player.price) || 0;
  const bid = Number(player.bid ?? price * 0.975);
  const ask = Number(player.ask ?? price * 1.025);
  const owned = Number(player.owned ?? 0);
  const balance = player.balance == null ? null : Number(player.balance);
  const max = Number(player.maxShares ?? 10);

  const cost = Math.ceil(ask * shares - 1e-9);
  const proceeds = Math.floor(bid * shares + 1e-9);
  const canBuy = owned + shares <= max && (balance == null || balance >= cost);
  const canSell = owned >= shares;

  const loadPending = () =>
    fetch('/api/market/portfolio', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.orders) return;
        setPending(d.orders.filter((o) => o.status === 'pending' && String(o.player_id) === String(player.id)));
      })
      .catch(() => {});

  useEffect(() => {
    if (!canTrade) return;
    loadPending();
    const id = setInterval(loadPending, 20_000);
    return () => clearInterval(id);
  }, [player.id, canTrade]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canTrade) {
    return (
      <button type="button" className="mk-trade" disabled>
        Trade · coming soon
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/market/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticker: player.ticker, side, shares }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Could not place the order.');
      setMsg({ ok: true, text: `Order in. It fills at the next tick, within a minute.` });
      loadPending();
      onChanged?.();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id) => {
    try {
      const r = await fetch('/api/market/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cancel: id }),
      });
      if (r.ok) loadPending();
    } catch {
      /* it may have filled */
    }
  };

  return (
    <div className="mk-sheet">
      <div className="mk-sheet-head">
        <div className="mk-seg" role="tablist">
          {['buy', 'sell'].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              className={side === s ? 'mk-seg-on' : ''}
              onClick={() => setSide(s)}
            >
              {s === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
        <div className="mk-sub">
          you own <strong>{owned}</strong>
          {balance != null && (
            <>
              {' · '}
              <strong>{balance}</strong> pts to spend
            </>
          )}
        </div>
      </div>

      <div className="mk-sheet-quote">
        <div>
          <span>Bid</span>
          {fmt(bid)}
        </div>
        <div>
          <span>Price</span>
          {fmt(price)}
        </div>
        <div>
          <span>Ask</span>
          {fmt(ask)}
        </div>
      </div>

      <div className="mk-sheet-qty">
        <button type="button" onClick={() => setShares((n) => Math.max(1, n - 1))} aria-label="Fewer">
          −
        </button>
        <div className="mk-sheet-n">
          {shares} <span>share{shares === 1 ? '' : 's'}</span>
        </div>
        <button type="button" onClick={() => setShares((n) => Math.min(max, n + 1))} aria-label="More">
          +
        </button>
      </div>

      <div className="mk-sheet-total">
        {side === 'buy' ? (
          <>
            Costs <strong>{cost}</strong> pts
            <span className="mk-sub"> · {shares} × {fmt(ask)}, rounded up</span>
          </>
        ) : (
          <>
            Pays <strong>{proceeds}</strong> pts
            <span className="mk-sub"> · {shares} × {fmt(bid)}, rounded down</span>
          </>
        )}
      </div>

      <button
        type="button"
        className={`mk-trade ${side === 'sell' ? 'mk-trade-sell' : ''}`}
        disabled={busy || (side === 'buy' ? !canBuy : !canSell)}
        onClick={submit}
      >
        {busy
          ? 'Placing…'
          : side === 'buy'
            ? canBuy
              ? `Buy ${shares} · ${cost} pts`
              : owned + shares > max
                ? `Max ${max} shares of one player`
                : 'Not enough points'
            : canSell
              ? `Sell ${shares} · ${proceeds} pts`
              : 'Nothing to sell'}
      </button>

      <p className="mk-note">
        Orders fill at the next recorded tick, within a minute, at that tick&apos;s price. The
        5% spread is the house&apos;s cut. Dividends pay 5% of his weekly points per share at the
        week&apos;s roll.
      </p>

      {msg && <div className={`mk-sheet-msg ${msg.ok ? 'mk-up' : 'mk-down'}`}>{msg.text}</div>}

      {pending.length > 0 && (
        <div className="mk-why-rows">
          {pending.map((o) => (
            <div key={o.id} className="mk-order-row">
              <span>
                {o.side === 'buy' ? 'Buying' : 'Selling'} {o.shares} · waiting for the next tick
              </span>
              <button type="button" className="mk-chip" onClick={() => cancel(o.id)}>
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
