'use client';

import { useState } from 'react';

/**
 * A player's headshot, with a fallback.
 *
 * Sleeper hosts these on its CDN with no key, but a player without one returns
 * 403 rather than a placeholder -- so a rookie or a practice-squad call-up
 * would render as a broken image. On error this falls back to initials, which
 * is better than an empty box and still tells you who it is.
 *
 * Plain <img> rather than next/image: these are small, external, and there are
 * up to a hundred on a results page. Optimising each one through the image
 * pipeline would cost more than it saves.
 */
export default function PlayerPhoto({ src, name, position, size = 34 }) {
  const [failed, setFailed] = useState(false);

  const initials = (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();

  if (!src || failed) {
    return (
      <span
        className="player-photo player-photo-fallback"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
        aria-hidden="true"
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      className={`player-photo ${position === 'DEF' ? 'player-photo-def' : ''}`}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
