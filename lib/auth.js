import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Who-are-you, not keep-people-out.
 *
 * This is play money among ten friends who all know each other, so the job is
 * to tell whose bankroll is whose -- not to withstand a determined attacker.
 * One shared password plus a name picked from a list is the right amount of
 * friction: anything more and nobody logs in on a Sunday morning.
 *
 * What it still has to do properly: a cookie must not be forgeable. Without a
 * signature anyone could set `bettor=kevin-malina` in dev tools and place bets
 * as Kevin, which would wreck the game for exactly the reason the hidden-bets
 * rule exists. So the identity is HMAC-signed with a server-side secret.
 */

const COOKIE = 'book_session';
const MAX_AGE_DAYS = 120; // a whole season, so nobody re-logs-in mid-Sunday

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
  const provided = token.slice(idx + 1);
  const expected = sign(slug);
  // Compare in constant time. The timing signal here is tiny, but the correct
  // primitive costs nothing.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return slug;
}

/** True if the shared password matches. */
export function checkPassword(input) {
  const expected = process.env.BOOK_PASSWORD;
  if (!expected) throw new Error('BOOK_PASSWORD is not set.');
  const a = Buffer.from(String(input ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The signed-in bettor's slug, or null. */
export async function currentBettor() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  return token ? verifyToken(token) : null;
}

export async function setSession(slug) {
  const jar = await cookies();
  jar.set(COOKIE, makeToken(slug), {
    httpOnly: true, // not readable from JS, so an XSS cannot lift it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_DAYS * 24 * 60 * 60,
  });
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** Generates a secret for .env.local. */
export function generateSecret() {
  return randomBytes(32).toString('base64url');
}
