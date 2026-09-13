'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * An award icon that explains itself.
 *
 * A strip of twelve emoji is a puzzle, and a native `title` only answers it on
 * a desktop hover -- most of the league is on a phone, where a title never
 * shows. Tap opens a bubble in the app's own style; tap anywhere else, or
 * Escape, closes it. Hover still works for the two people on a laptop.
 *
 * The bubble is kept on screen. Anchoring it to the badge's left or right
 * edge fails on a phone -- a badge mid-screen cannot fit a 260px bubble on
 * either side -- so it is measured once shown, slid to fit inside the
 * viewport, and the arrow slides the other way to keep pointing at the badge.
 */
const EDGE = 8;

export default function Badge({ icon, label }) {
  const [open, setOpen] = useState(false);
  // Where the bubble sits relative to the badge, and where its arrow points.
  const [pos, setPos] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const tip = ref.current.querySelector('.badge-tip');
    if (!tip) return;
    const badge = ref.current.getBoundingClientRect();
    // Measured at its natural, badge-aligned position.
    tip.style.left = '0';
    const width = tip.getBoundingClientRect().width;
    tip.style.left = '';
    const wanted = badge.left;
    const clamped = Math.max(EDGE, Math.min(wanted, window.innerWidth - width - EDGE));
    setPos({
      left: clamped - badge.left,
      arrow: Math.max(8, Math.min(width - 20, badge.left + badge.width / 2 - clamped - 6)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className={`badge ${open ? 'badge-open' : ''}`}
      // A button, so it is reachable by keyboard and reads as tappable.
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={open}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen((o) => !o);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
    >
      {icon}
      <span
        className="badge-tip"
        role="tooltip"
        style={pos ? { left: pos.left, '--arrow': `${pos.arrow}px` } : undefined}
      >
        {label}
      </span>
    </span>
  );
}
