import { createHmac, timingSafeEqual, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { neon } from '@neondatabase/serverless';
import { GUEST_SLUG, isGuestSlug, makeToken, verifyToken } from './identity.js';

// Re-exported so callers have one place to import identity from.
export { GUEST_SLUG, isGuestSlug, makeToken, verifyToken };

const scrypt = promisify(scryptCb);
/**
 * Connect lazily, on first query rather than at import.
 *
 * `neon(process.env.DATABASE_URL)` runs the moment this module is loaded, which
 * during a build is before any page has asked for data. If DATABASE_URL is
 * missing there -- as it is on a first deploy, or any preview branch without
 * the variable -- the whole build dies instead of just the pages that need a
 * database. Deferring means a missing variable is a runtime error on one page,
 * not a failed deploy.
 */
let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

/**
 * Identity for The Book.
 *
 * Each manager has their own password, set the first time they sign in. A
 * single shared password was the original design and it was wrong: bets are
 * hidden until a market locks, and that rule is enforced in SQL -- but it is
 * worthless if Chad can pick "Kevin Malina" from a dropdown, type the password
 * everyone knows, and read Kevin's picks before kickoff. Whoever you claim to
 * be has to be something only you can prove.
 *
 * Two separate secrets are at work here:
 *   - password_hash  proves you are who you say (scrypt, per-user salt)
 *   - session cookie proves you already did that (HMAC, server secret)
 * Neither can substitute for the other, and neither is stored in a form that
 * lets someone read a password back out.
 */

const COOKIE = 'book_session';
const MAX_AGE_DAYS = 120; // a whole season, so nobody re-logs-in mid-Sunday
const MIN_PASSWORD = 6;

/* ---------- passwords ---------- */

/** `salt:hash`, both hex. scrypt is deliberately slow, which is the point. */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, keyHex] = stored.split(':');
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

/** Everyone, with whether they have claimed their account yet. */
export async function listBettors() {
  return sql`
    select slug, display_name, (password_hash is not null) as has_password, is_commissioner
    from bettors order by display_name`;
}

/**
 * Signs in, or claims the account if this is the first time.
 *
 * Returns { ok, slug, claimed } or { error }. Claiming is deliberately not a
 * separate endpoint: one flow means nobody has to be told which button to press.
 */
export async function authenticate(slug, password) {
  // Guests sign in with no password at all. There is nothing to protect: the
  // view is read-only and shows only what is already public to every manager.
  if (isGuestSlug(slug)) {
    return { ok: true, slug: GUEST_SLUG, claimed: false, name: 'Guest', guest: true };
  }

  const [row] = await sql`
    select slug, display_name, password_hash from bettors where slug = ${slug}`;
  if (!row) return { error: 'Pick who you are.' };

  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }

  if (!row.password_hash) {
    // First sign-in claims the account. Whoever gets here first owns the name,
    // which is why the commissioner can reset it -- a land grab is obvious and
    // fixable, and gating ten sign-ups behind approval is worse friction.
    const hash = await hashPassword(pw);
    await sql`
      update bettors set password_hash = ${hash}, password_set_at = now()
      where slug = ${slug} and password_hash is null`;
    return { ok: true, slug, claimed: true, name: row.display_name };
  }

  if (!(await verifyPassword(pw, row.password_hash))) {
    return { error: 'Wrong password.' };
  }
  return { ok: true, slug, claimed: false, name: row.display_name };
}

/** Commissioner action: clear a password so the person can set a new one. */
export async function resetPassword(slug) {
  const [row] = await sql`
    update bettors set password_hash = null, password_set_at = null
    where slug = ${slug}
    returning slug, display_name`;
  if (!row) throw new Error('No such bettor.');
  return row;
}

/* ---------- sessions ---------- */

/** The signed-in bettor's slug, or null. */
export async function currentBettor() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  return token ? verifyToken(token) : null;
}

/**
 * The signed-in MANAGER's slug -- null for a guest as well as for nobody.
 *
 * Use this anywhere a slug is about to own something: a bet, a bankroll, a
 * ledger row. `currentBettor` answers "is someone signed in", which is a
 * different question and the wrong one for a write.
 */
export async function currentManager() {
  const slug = await currentBettor();
  return slug && !isGuestSlug(slug) ? slug : null;
}

/** True when the signed-in user may reset passwords and approve re-ups. */
export async function isCommissioner() {
  const slug = await currentBettor();
  if (!slug || isGuestSlug(slug)) return false;
  const [row] = await sql`select is_commissioner from bettors where slug = ${slug}`;
  return Boolean(row?.is_commissioner);
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
