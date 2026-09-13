'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import PlayerPhoto from '@/components/PlayerPhoto';

const SORTS = [
  { key: 'movers', label: 'Movers', by: (a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) },
  { key: 'gainers', label: 'Gainers', by: (a, b) => b.changePct - a.changePct },
  { key: 'losers', label: 'Losers', by: (a, b) => a.changePct - b.changePct },
  { key: 'price', label: 'Price', by: (a, b) => b.price - a.price },
  { key: 'ticker', label: 'A–Z', by: (a, b) => a.ticker.localeCompare(b.ticker) },
];
const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'DEF'];
const POLL_MS = 30_000;

const fmt = (n) => (Number(n) || 0).toFixed(2);
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}`;

/**
 * The watchlist. Polls the quotes route every half minute while the tab is
 * visible, so on a Sunday the numbers move without a reload.
 */
export default function MarketList({ initial, source }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [sort, setSort] = useState('movers');
  const [pos, setPos] = useState('ALL');
  const [query, setQuery] = useState('');
  // The "as of" clock is the viewer's local time, unknown to the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(`/api/market/quotes?source=${source}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive && d?.rows) setData(d);
      } catch {
        /* keep what we have */
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [source]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const by = SORTS.find((s) => s.key === sort)?.by ?? SORTS[0].by;
    return (data.rows ?? [])
      .filter((p) => pos === 'ALL' || p.position === pos)
      .filter(
        (p) =>
          !q ||
          p.ticker.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.team ?? '').toLowerCase().includes(q),
      )
      .sort(by);
  }, [data, sort, pos, query]);

  const asOf = data.asOf ? new Date(data.asOf) : null;
  const liveCount = (data.rows ?? []).filter((p) => p.inGame).length;

  return (
    <section className="section">
      <div className="mk-head">
        <div>
          <h1 className="mk-title">The Market</h1>
          <div className="mk-sub">
            {data.week ? `Week ${data.week} · ` : ''}
            {asOf && mounted
              ? `as of ${asOf.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
              : ''}
            {liveCount > 0 && (
              <>
                {' · '}
                <span className="mk-live">
                  <span className="mk-live-dot" />
                  {liveCount} in play
                </span>
              </>
            )}
          </div>
        </div>
        <div className="mk-seg" role="tablist" aria-label="Price source">
          {['mock', 'live'].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={source === s}
              className={source === s ? 'mk-seg-on' : ''}
              onClick={() => router.push(`/market?source=${s}`)}
            >
              {s === 'mock' ? 'Mock' : 'Live'}
            </button>
          ))}
        </div>
      </div>

      {source === 'mock' && (
        <p className="mk-note">
          Invented prices on real players. They move with the clock, loudest on Sunday,
          Monday and Thursday nights. Switch to Live for the real feed.
        </p>
      )}
      {data.error && <div className="empty">Could not load the board: {data.error}</div>}

      <input
        className="mk-search"
        type="search"
        placeholder="Search a player, ticker or team"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="mk-chips">
        {POSITIONS.map((p) => (
          <button
            key={p}
            type="button"
            className={`mk-chip ${pos === p ? 'mk-chip-on' : ''}`}
            onClick={() => setPos(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="mk-chips">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`mk-chip ${sort === s.key ? 'mk-chip-on' : ''}`}
            onClick={() => setSort(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="mk-rows">
        {rows.length === 0 && !data.error && <div className="empty">Nothing matches.</div>}
        {rows.map((p) => {
          const up = p.change > 0;
          const down = p.change < 0;
          return (
            <Link
              key={p.ticker}
              href={`/market/${p.ticker}?source=${source}`}
              className="mk-row"
            >
              <PlayerPhoto src={p.photo} name={p.name} position={p.position} size={40} />
              <div className="mk-row-main">
                <div className="mk-sym">
                  {p.ticker}
                  <span className="mk-pos">
                    {p.position}
                    {p.team ? ` · ${p.team}` : ''}
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
                <div className="mk-price">{fmt(p.price)}</div>
                <div className={`mk-chg ${up ? 'mk-up' : down ? 'mk-down' : ''}`}>
                  {signed(p.change)} {signed(p.changePct)}%
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
