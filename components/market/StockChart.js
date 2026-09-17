'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import PlayerPhoto from '@/components/PlayerPhoto';
import TradeSheet from './TradeSheet';

// WEEK first and default: this market has a session, and it is the week. It
// runs from the Tuesday roll rather than a rolling window, so nothing that
// happened since prices reset can age out of view.
const RANGES = ['WEEK', '1D', '1W', '2W', '1M', '2M', '3M'];
const RANGE_LABEL = { WEEK: 'Week' };
const labelFor = (r) => RANGE_LABEL[r] ?? r;
const POLL_MS = 30_000;

const fmt = (n) => (Number(n) || 0).toFixed(2);
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function axisStamp(t, range) {
  const d = new Date(t);
  if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (range === 'WEEK' || range === '1W' || range === '2W')
    return d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const fullStamp = (t) =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Why did it move. Every recorded move in the range with the input that
 * caused it, newest first. An UNEXPLAINED row is a price that changed while
 * no input did, which is a bug worth a look. Live source only: the mock has
 * no inputs, only noise.
 */
function WhyPanel({ ticker, range, mounted }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/market/why?ticker=${encodeURIComponent(ticker)}&range=${range}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setData(d))
        .catch(() => {});
    load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ticker, range]);

  const moves = data?.moves ?? [];
  const shown = open ? moves : moves.slice(0, 12);
  const odd = moves.filter((m) => m.reason === 'UNEXPLAINED').length;

  return (
    <div className="mk-why">
      <div className="section-head">
        <h2>Why did it move</h2>
        <a href={`/api/market/why?ticker=${encodeURIComponent(ticker)}&range=${range}&format=csv`}>
          CSV
        </a>
      </div>
      {data && (
        <div className="mk-sub">
          {data.ticks} ticks in this range · {moves.length} moves
          {odd > 0 && <span className="mk-down"> · {odd} unexplained</span>}
        </div>
      )}
      <div className="mk-why-rows">
        {shown.length === 0 && (
          <div className="empty">{data ? 'No moves recorded in this range.' : 'Loading…'}</div>
        )}
        {shown.map((m) => (
          <div key={m.t} className={`mk-why-row ${m.reason === 'UNEXPLAINED' ? 'mk-why-odd' : ''}`}>
            <span className="mk-why-time">{mounted ? fullStamp(m.t) : ''}</span>
            <span className={`mk-why-delta ${m.delta > 0 ? 'mk-up' : m.delta < 0 ? 'mk-down' : ''}`}>
              {signed(m.delta)}
            </span>
            <span className="mk-why-reason">{m.reason}</span>
            <span className="mk-why-detail">{m.detail}</span>
          </div>
        ))}
      </div>
      {moves.length > 12 && (
        <button type="button" className="mk-chip" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show fewer' : `Show all ${moves.length}`}
        </button>
      )}
    </div>
  );
}

/* Chart geometry, in CSS pixels. The svg is as wide as its container. */
const H = 300;
const PAD = { top: 12, right: 50, bottom: 22, left: 6 };
const VOL_H = 40;

/**
 * One stock's page: header, candle or line chart, range tabs.
 *
 * Drawn by hand in SVG rather than a chart library. The chart is small, the
 * data is already bucketed, and the touch behaviour -- press and drag to read
 * a candle, page scrolls otherwise -- is easier to get right than to
 * configure. The header shows whatever candle is under the finger.
 */
export default function StockChart({ initial, source, canTrade = false }) {
  const [data, setData] = useState(initial);
  const [range, setRange] = useState(initial.range);
  const [mode, setMode] = useState('candles');
  const [hover, setHover] = useState(null);
  const [width, setWidth] = useState(360);
  // Times are formatted in the viewer's zone, which the server does not know:
  // rendering them on the server produced a hydration mismatch. They appear
  // after mount.
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => setMounted(true), []);

  const player = data.player;
  const candles = data.candles ?? [];

  const load = useCallback(
    async (r) => {
      try {
        const res = await fetch(
          `/api/market/history?ticker=${encodeURIComponent(player.ticker)}&range=${r}&source=${source}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const d = await res.json();
        if (d?.player) setData(d);
      } catch {
        /* keep what is on screen */
      }
    },
    [player.ticker, source],
  );

  // A new range fetches; the url remembers it so a reload lands on the same view.
  useEffect(() => {
    if (range !== data.range) load(range);
    window.history.replaceState(null, '', `?source=${source}&range=${range}`);
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load(range);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [range, load]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- scales ---------- */
  const n = candles.length;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const priceTop = PAD.top;
  const priceBottom = H - PAD.bottom - VOL_H - 8;
  const volTop = priceBottom + 8;
  const volBottom = H - PAD.bottom;
  const slot = n ? plotW / n : plotW;

  // The reference line and the change figure are the price at the START OF THE
  // SELECTED RANGE, not a projection-derived baseline that moves with the
  // price. The old one always read 0.00 / 0.00%, which told you nothing about
  // a stock that had halved since Tuesday.
  const prevClose = player.rangeOpen ?? player.prevClose;
  // "Week" when the range is anchored to the roll, otherwise name the window.
  const statLabel = range === 'WEEK' ? 'Week' : range;
  const openLabel = range === 'WEEK' ? "Week's open" : 'Range open';
  let lo = prevClose;
  let hi = prevClose;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  const span = Math.max(hi - lo, Math.max(0.5, prevClose * 0.02));
  lo -= span * 0.06;
  hi += span * 0.06;
  const y = (p) => priceTop + ((hi - p) / (hi - lo)) * (priceBottom - priceTop);
  const x = (i) => PAD.left + i * slot + slot / 2;
  const vmax = candles.reduce((m, c) => Math.max(m, c.v), 0) || 1;

  const shown = hover != null && candles[hover] ? candles[hover] : null;
  const price = shown ? shown.c : player.price;
  const change = price - prevClose;
  const changePct = prevClose ? (price / prevClose - 1) * 100 : 0;
  const tone = change > 0 ? 'mk-up' : change < 0 ? 'mk-down' : '';
  const lineUp = n ? candles[n - 1].c >= (candles[0]?.o ?? prevClose) : true;

  const pick = (e) => {
    if (!n) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - PAD.left;
    setHover(clamp(Math.round((px - slot / 2) / slot), 0, n - 1));
  };

  const gridPrices = [hi - span * 0.06, (hi + lo) / 2, lo + span * 0.06];
  const labelIdx = n > 1 ? [0, 1, 2, 3].map((k) => Math.round((k * (n - 1)) / 3)) : [];
  const linePath = n
    ? candles.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(c.c).toFixed(1)}`).join(' ')
    : '';

  return (
    <section className="section">
      <Link href={`/market?source=${source}`} className="back">
        ‹ The Market
      </Link>

      <div className="mk-stock-head">
        <PlayerPhoto src={player.photo} name={player.name} position={player.position} size={44} />
        <div className="mk-row-main">
          <div className="mk-stock-name">{player.name}</div>
          <div className="mk-sub">
            {player.ticker} · {player.position}
            {player.team ? ` · ${player.team}` : ''}
            {player.inGame && (
              <span className="mk-live">
                <span className="mk-live-dot" />
                LIVE
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mk-quote">
        <div className="mk-big">
          {fmt(price)} <span className="mk-unit">pts</span>
        </div>
        <div className={`mk-chg mk-chg-big ${tone}`}>
          {signed(change)} {signed(changePct)}%{' '}
          <span className="mk-sub">
            {shown
              ? mounted
                ? fullStamp(shown.t)
                : ''
              : source === 'live'
                ? range === 'WEEK'
                  ? 'since the week opened'
                  : `over ${range}`
                : '24h'}
          </span>
        </div>
        {shown && (
          <div className="mk-ohlc">
            <span>O {fmt(shown.o)}</span>
            <span>H {fmt(shown.h)}</span>
            <span>L {fmt(shown.l)}</span>
            <span>C {fmt(shown.c)}</span>
            <span>Vol {shown.v.toLocaleString()}</span>
          </div>
        )}
      </div>

      <div className="mk-chart" ref={wrapRef}>
        {n === 0 ? (
          <div className="mk-chart-empty">{data.note ?? 'No prices in this range yet.'}</div>
        ) : (
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              pick(e);
            }}
            onPointerMove={pick}
            onPointerUp={() => setHover(null)}
            onPointerLeave={() => setHover(null)}
            onPointerCancel={() => setHover(null)}
          >
            <defs>
              <linearGradient id="mk-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineUp ? 'var(--positive)' : 'var(--negative)'} stopOpacity="0.28" />
                <stop offset="100%" stopColor={lineUp ? 'var(--positive)' : 'var(--negative)'} stopOpacity="0" />
              </linearGradient>
            </defs>

            {gridPrices.map((p, i) => (
              <g key={i}>
                <line className="mk-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(p)} y2={y(p)} />
                <text className="mk-axis" x={PAD.left + plotW + 6} y={y(p) + 4}>
                  {fmt(p)}
                </text>
              </g>
            ))}

            <line
              className="mk-prev"
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(prevClose)}
              y2={y(prevClose)}
            />
            <text className="mk-axis mk-axis-prev" x={PAD.left + plotW + 6} y={y(prevClose) - 5}>
              {fmt(prevClose)}
            </text>

            {mode === 'candles'
              ? candles.map((c, i) => {
                  const up = c.c >= c.o;
                  const bw = Math.max(1.5, slot * 0.62);
                  const top = y(Math.max(c.o, c.c));
                  const h = Math.max(1, Math.abs(y(c.o) - y(c.c)));
                  return (
                    <g key={c.t} className={up ? 'mk-candle-up' : 'mk-candle-down'}>
                      <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} />
                      <rect x={x(i) - bw / 2} y={top} width={bw} height={h} />
                    </g>
                  );
                })
              : (
                <g className={lineUp ? 'mk-line-up' : 'mk-line-down'}>
                  <path
                    className="mk-area"
                    d={`${linePath} L${x(n - 1).toFixed(1)} ${priceBottom} L${x(0).toFixed(1)} ${priceBottom} Z`}
                  />
                  <path className="mk-line" d={linePath} />
                </g>
              )}

            {candles.map((c, i) => {
              const h = ((c.v / vmax) * (volBottom - volTop)) || 0;
              const bw = Math.max(1, slot * 0.62);
              return (
                <rect
                  key={c.t}
                  className={c.c >= c.o ? 'mk-vol-up' : 'mk-vol-down'}
                  x={x(i) - bw / 2}
                  y={volBottom - h}
                  width={bw}
                  height={h}
                />
              );
            })}

            {mounted &&
              labelIdx.map((i, k) => (
                <text
                  key={k}
                  className="mk-axis"
                  x={x(i)}
                  y={H - 6}
                  textAnchor={k === 0 ? 'start' : k === 3 ? 'end' : 'middle'}
                >
                  {axisStamp(candles[i].t, range)}
                </text>
              ))}

            {shown && (
              <g className="mk-cross">
                <line x1={x(hover)} x2={x(hover)} y1={priceTop} y2={volBottom} />
                <circle cx={x(hover)} cy={y(shown.c)} r={3.5} />
              </g>
            )}
          </svg>
        )}
      </div>

      {n > 0 && data.note && <p className="mk-note">{data.note}</p>}

      <div className="mk-ranges">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={`mk-range ${range === r ? 'mk-range-on' : ''}`}
            onClick={() => setRange(r)}
          >
            {labelFor(r)}
          </button>
        ))}
        <button
          type="button"
          className="mk-range mk-mode"
          aria-label={mode === 'candles' ? 'Show line' : 'Show candles'}
          onClick={() => setMode((m) => (m === 'candles' ? 'line' : 'candles'))}
        >
          {mode === 'candles' ? '〰' : '▮'}
        </button>
      </div>

      <div className="mk-stats">
        <div>
          <span>{source === 'live' ? openLabel : '24h ago'}</span>
          {fmt(prevClose)}
        </div>
        <div>
          <span>{statLabel} high</span>
          {fmt(player.rangeHigh ?? player.dayHigh)}
        </div>
        <div>
          <span>{statLabel} low</span>
          {fmt(player.rangeLow ?? player.dayLow)}
        </div>
        <div>
          <span>Projection</span>
          {fmt(player.projection)}
        </div>
        {source === 'live' && (
          <div>
            <span>Scored</span>
            {fmt(player.points)}
          </div>
        )}
        {source === 'live' && (
          <div>
            <span>Carried</span>
            {signed(player.premium ?? 0)}
          </div>
        )}
        {source === 'live' && player.dividend != null && (
          <div>
            <span>Last dividend</span>
            {fmt(player.dividend)}
            <span className="mk-unit-sm">/share on {fmt(player.lastActual)} pts</span>
          </div>
        )}
      </div>

      {source === 'live' ? (
        <TradeSheet player={player} canTrade={canTrade} onChanged={() => load(range)} />
      ) : (
        <button type="button" className="mk-trade" disabled>
          Trade · not on mock prices
        </button>
      )}

      {source === 'live' && <WhyPanel ticker={player.ticker} range={range} mounted={mounted} />}
    </section>
  );
}
