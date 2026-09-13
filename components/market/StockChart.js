'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import PlayerPhoto from '@/components/PlayerPhoto';

const RANGES = ['1D', '1W', '2W', '1M', '2M', '3M'];
const POLL_MS = 30_000;

const fmt = (n) => (Number(n) || 0).toFixed(2);
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function axisStamp(t, range) {
  const d = new Date(t);
  if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (range === '1W' || range === '2W') return d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const fullStamp = (t) =>
  new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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
export default function StockChart({ initial, source }) {
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

  const prevClose = player.prevClose;
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
            {shown ? (mounted ? fullStamp(shown.t) : '') : source === 'live' ? 'vs projection' : '24h'}
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

      <div className="mk-ranges">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            className={`mk-range ${range === r ? 'mk-range-on' : ''}`}
            onClick={() => setRange(r)}
          >
            {r}
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
          <span>{source === 'live' ? 'Baseline' : '24h ago'}</span>
          {fmt(prevClose)}
        </div>
        <div>
          <span>24h high</span>
          {fmt(player.dayHigh)}
        </div>
        <div>
          <span>24h low</span>
          {fmt(player.dayLow)}
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
      </div>

      <button type="button" className="mk-trade" disabled>
        Trade · coming soon
      </button>
    </section>
  );
}
