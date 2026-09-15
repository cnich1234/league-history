'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import PlayerPhoto from '@/components/PlayerPhoto';

const fmt = (n) => (Number(n) || 0).toFixed(2);
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}`;
const POLL_MS = 30_000;

/**
 * What you own, what it is worth at the bid, what it cost, and what it has
 * paid you. Polls so a fill shows up without a reload.
 */
export default function Portfolio({ initial }) {
  const [data, setData] = useState(initial);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/market/portfolio', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d?.positions && setData(d))
        .catch(() => {});
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const cancel = async (id) => {
    try {
      await fetch('/api/market/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cancel: id }),
      });
      const r = await fetch('/api/market/portfolio', { cache: 'no-store' });
      if (r.ok) setData(await r.json());
    } catch {
      /* it may have filled */
    }
  };

  const gain = data.value - data.cost;
  const pending = (data.orders ?? []).filter((o) => o.status === 'pending');
  const history = (data.orders ?? []).filter((o) => o.status !== 'pending').slice(0, 20);
  const stamp = (t) => (mounted && t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  return (
    <section className="section">
      <Link href="/market" className="back">
        ‹ The Market
      </Link>
      <div className="mk-head">
        <div>
          <h1 className="mk-title">My Portfolio</h1>
          <div className="mk-sub">Week {data.week} · {data.points} pts to spend</div>
        </div>
      </div>

      <div className="mk-stats">
        <div>
          <span>Holdings</span>
          {fmt(data.value)}
          <span className="mk-unit-sm">at the bid</span>
        </div>
        <div>
          <span>Cost</span>
          {data.cost}
        </div>
        <div className={gain > 0 ? 'mk-up' : gain < 0 ? 'mk-down' : ''}>
          <span>Gain</span>
          {signed(gain)}
        </div>
        <div>
          <span>Dividends</span>
          {fmt(data.dividendTotal)}
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 14 }}>
        <h2>Positions</h2>
        <span className="dim">max {data.rules?.maxShares ?? 10} a player</span>
      </div>
      <div className="mk-rows">
        {data.positions.length === 0 && (
          <div className="empty">You own nothing yet. Open a player and tap Buy.</div>
        )}
        {data.positions.map((p) => (
          <Link key={p.playerId} href={`/market/${p.ticker}`} className="mk-row">
            <PlayerPhoto src={p.photo} name={p.name} position={p.position} size={40} />
            <div className="mk-row-main">
              <div className="mk-sym">
                {p.ticker}
                <span className="mk-pos">
                  {p.shares} share{p.shares === 1 ? '' : 's'} · cost {p.cost}
                </span>
                {p.inGame && (
                  <span className="mk-live">
                    <span className="mk-live-dot" />
                    LIVE
                  </span>
                )}
              </div>
              <div className="mk-name">{p.name}</div>
            </div>
            <div className="mk-row-right">
              <div className="mk-price">{fmt(p.value)}</div>
              <div className={`mk-chg ${p.gain > 0 ? 'mk-up' : p.gain < 0 ? 'mk-down' : ''}`}>
                {signed(p.gain)} · {fmt(p.bid)} bid
              </div>
            </div>
          </Link>
        ))}
      </div>

      {pending.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 18 }}>
            <h2>Waiting for the next tick</h2>
          </div>
          <div className="mk-why-rows">
            {pending.map((o) => (
              <div key={o.id} className="mk-order-row">
                <span>
                  {o.side === 'buy' ? 'Buy' : 'Sell'} {o.shares} × {o.ticker} · placed {stamp(o.placed_at)}
                </span>
                <button type="button" className="mk-chip" onClick={() => cancel(o.id)}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 18 }}>
            <h2>Trades</h2>
          </div>
          <div className="mk-why-rows">
            {history.map((o) => (
              <div key={o.id} className={`mk-why-row ${o.status === 'rejected' ? 'mk-why-odd' : ''}`}>
                <span className="mk-why-time">{stamp(o.filled_at ?? o.placed_at)}</span>
                <span className={`mk-why-delta ${o.points > 0 ? 'mk-up' : o.points < 0 ? 'mk-down' : ''}`}>
                  {o.points == null ? '' : signed(o.points).replace('.00', '')}
                </span>
                <span className="mk-why-reason">
                  {o.status === 'filled' ? `${o.side === 'buy' ? 'Bought' : 'Sold'} ${o.shares} × ${o.ticker}` : `${o.status} · ${o.side} ${o.shares} × ${o.ticker}`}
                </span>
                <span className="mk-why-detail">{o.status === 'filled' ? `at ${fmt(o.price)}` : o.note ?? ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {data.dividends.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 18 }}>
            <h2>Dividends</h2>
          </div>
          <div className="mk-why-rows">
            {data.dividends.map((d) => (
              <div key={`${d.week}-${d.player_id}`} className="mk-why-row">
                <span className="mk-why-time">Week {d.week}</span>
                <span className="mk-why-delta mk-up">+{fmt(d.points)}</span>
                <span className="mk-why-reason">{d.ticker}</span>
                <span className="mk-why-detail">
                  {d.shares} share{d.shares === 1 ? '' : 's'} on {fmt(d.actual)} pts
                </span>
              </div>
            ))}
          </div>
          <p className="mk-note">Dividends are paid to your points as one rounded-down total per week.</p>
        </>
      )}
    </section>
  );
}
