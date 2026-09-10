'use client';

import { useState } from 'react';
import MatchupModal from './MatchupModal';

/**
 * Opens the lineup view for one matchup.
 *
 * A small client island rather than making the whole card interactive: the card
 * stays server-rendered, and only this button ships JavaScript. The modal
 * itself is loaded lazily by React when first opened.
 */
export default function MatchupButton({ home, away, week }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="view-matchup" type="button" onClick={() => setOpen(true)}>
        View lineups
      </button>
      {open && (
        <MatchupModal home={home} away={away} week={week} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
