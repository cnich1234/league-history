import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Who someone is, without touching cookies or the database.
 *
 * Split out of auth.js so it can be tested: that module imports `next/headers`,
 * which only resolves inside a Next request, so a plain `node` test of the
 * guest rules could not load it at all.
 *
 * Everything here is a pure function of its arguments.
 */

/**
 * Read-only guest.
 *
 * Deliberately NOT a row in `bettors`. A guest with a real slug would flow into
 * placeBet, getMyBets and the bankroll view as though it were a manager -- it
 * could own bets and hold money. Keeping it outside the table means every query
 * that joins on a bettor simply finds nothing, which is the correct answer
 * rather than a special case to remember.
 *
 * The name is reserved so a real manager can never be given it.
 */
export const GUEST_SLUG = '__guest__';

/** True when this session is the read-only guest rather than a manager. */
export function isGuestSlug(slug) {
  return slug === GUEST_SLUG;
}

/* ---------- session tokens ---------- */

function secret() {
  const s = process.env.BOOK_SESSION_SECRET;
  if (!s) throw new Error('BOOK_SESSION_SECRET is not set.');
  return s;
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

/** `slug.signature` -- readable, and useless to tamper with. */
export function makeToken(slug) {
  return `${slug}.${sign(slug)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const slug = token.slice(0, idx);
  const provided = Buffer.from(token.slice(idx + 1));
  const expected = Buffer.from(sign(slug));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return slug;
}
