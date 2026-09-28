'use client';

import { useState } from 'react';

/**
 * The 🎯 on a bet that has been hit. Tap it to see WHICH attack landed.
 *
 * Only the attack's name ever reaches this component, never who used it --
 * that is what a Receipt is for, and it is not on the page to leak. The
 * victim's own push notification already names the attack, so this puts the
 * same fact where the rest of the league can see it.
 */
export default function HitPill({ icon, name }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="pill hit-pill"
      onClick={() => setOpen((o) => !o)}
      aria-expanded={open}
      aria-label={open ? `Hit by ${name}` : 'Which attack hit this bet?'}
    >
      🎯
      {open && (
        <span className="hit-pill-name">
          {icon} {name}
        </span>
      )}
    </button>
  );
}
