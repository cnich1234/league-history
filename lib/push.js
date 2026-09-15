/**
 * Phone notifications, by web push.
 *
 * Both platforms deliver these to a home-screen web app the way they would
 * to a native one: Android Chrome always, iPhone since 16.4 and only once
 * the site is on the home screen. No third party sits in the middle -- the
 * app signs each push with its own VAPID key pair and the phone's browser
 * vendor delivers it.
 *
 * Every send is best-effort. A dead subscription (the push service answers
 * 404 or 410) is deleted; any other failure is logged and swallowed, because
 * a notification must never take down the action that caused it.
 *
 * Own connection, like the Market: the shop and cron call in, and nothing
 * here reaches back into them.
 */
import { neon } from '@neondatabase/serverless';

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

const SITE = process.env.SITE_URL ?? 'https://league-history-loeg.vercel.app';

/** True when the keys are present. Without them every send is a no-op. */
export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function publicKey() {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

let _webpush = null;
async function client() {
  if (!pushConfigured()) return null;
  if (!_webpush) {
    const mod = await import('web-push');
    _webpush = mod.default ?? mod;
    _webpush.setVapidDetails(
      process.env.VAPID_SUBJECT ?? 'mailto:ethiopian123@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  }
  return _webpush;
}

/* ---------- subscriptions ---------- */

export async function saveSubscription(slug, subscription, userAgent = null) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error('That is not a push subscription.');
  const [row] = await sql`
    insert into push_subscriptions (bettor, endpoint, p256dh, auth, user_agent)
    values (${slug}, ${endpoint}, ${p256dh}, ${auth}, ${userAgent})
    on conflict (endpoint) do update
      set bettor = excluded.bettor, p256dh = excluded.p256dh, auth = excluded.auth,
          user_agent = excluded.user_agent, failed_at = null
    returning id`;
  return row;
}

export async function removeSubscription(slug, endpoint) {
  const rows = await sql`
    delete from push_subscriptions where endpoint = ${endpoint} and bettor = ${slug} returning id`;
  return rows.length;
}

export async function subscriptionsFor(slug) {
  return sql`select id, endpoint, p256dh, auth from push_subscriptions where bettor = ${slug}`;
}

export async function subscriberCount(slug) {
  const [row] = await sql`select count(*)::int as n from push_subscriptions where bettor = ${slug}`;
  return Number(row?.n ?? 0);
}

/* ---------- sending ---------- */

/**
 * Sends one payload to every device a manager has. Returns how many were
 * delivered. `payload` is { title, body, url?, tag? }; `url` is where a tap
 * opens, relative to the site.
 */
export async function notify(slug, payload) {
  const wp = await client();
  if (!wp) return 0;
  const subs = await subscriptionsFor(slug).catch(() => []);
  if (!subs.length) return 0;
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    url: payload.url ? new URL(payload.url, SITE).toString() : SITE,
    tag: payload.tag ?? undefined,
  });
  let sent = 0;
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        TTL: 60 * 60 * 6,
        urgency: 'high',
      });
      sent++;
      await sql`update push_subscriptions set last_ok_at = now() where id = ${s.id}`;
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        await sql`delete from push_subscriptions where id = ${s.id}`;
      } else {
        await sql`update push_subscriptions set failed_at = now() where id = ${s.id}`.catch(() => {});
        console.error('push failed', slug, code ?? e?.message);
      }
    }
  }
  return sent;
}

/** The same payload to several managers. */
export async function notifyMany(slugs, payload) {
  let sent = 0;
  for (const slug of new Set(slugs)) sent += await notify(slug, payload).catch(() => 0);
  return sent;
}

/** Everyone with a device, minus anyone in `except`. */
export async function notifyAll(payload, { except = [] } = {}) {
  const rows = await sql`select distinct bettor from push_subscriptions`.catch(() => []);
  const skip = new Set(except);
  return notifyMany(rows.map((r) => r.bettor).filter((s) => !skip.has(s)), payload);
}

/* ---------- what the app says ---------- */

/** Who owns a bet, and what it looks like, for the message. */
export async function betOwner(betId) {
  const [row] = await sql`
    select bettor, stake_cents, odds, is_parlay from bets where id = ${betId}`;
  return row ?? null;
}

const money = (cents) => `$${(Number(cents) / 100).toFixed(0)}`;
const oddsText = (o) => (Number(o) > 0 ? `+${o}` : `${o}`);

/** A bet of yours was attacked. Nobody is named: that is what Receipts are for. */
export async function notifyAttack(betId, boostName) {
  const bet = await betOwner(betId).catch(() => null);
  if (!bet) return 0;
  const what = bet.is_parlay ? `your ${money(bet.stake_cents)} parlay` : `your ${money(bet.stake_cents)} bet at ${oddsText(bet.odds)}`;
  return notify(bet.bettor, {
    title: `🎯 ${boostName} landed on ${what}`,
    body: 'Someone in the league just came for you. Open The Action to see the damage.',
    url: '/book/action',
    tag: `attack-${betId}`,
  });
}

/**
 * The rest of the league hears a bounty went up, without hearing on whom.
 * That is the point of a bounty being public: points are on the table.
 * The target gets the personal version; the poster knows already.
 */
const BOUNTY_LINES = [
  'A bounty has been placed on a scrub.',
  'Somebody in this league just put a price on a head. Not yours. Probably.',
  'Points are on the table for whoever lands the hit. Check the Bounties tab.',
  'A manager has been marked. The weapon is named, the target is sweating.',
  'Fresh bounty posted. One of you is about to have a bad Sunday.',
];
export async function notifyBountyPosted({ poster, target, weapon, points }) {
  const line = BOUNTY_LINES[Math.floor(Math.random() * BOUNTY_LINES.length)];
  return notifyAll(
    {
      title: `🎯 ${points}-point bounty posted`,
      body: `${line} Weapon: ${weapon}.`,
      url: '/book/bounties',
      tag: 'bounty-posted',
    },
    { except: [poster, target] },
  );
}

/** Somebody posted a bounty on you. */
export async function notifyBounty(targetSlug, { weapon, points }) {
  return notify(targetSlug, {
    title: `🎯 ${points}-point bounty on your head`,
    body: `The weapon is ${weapon}. Anyone who lands it collects. Insurance goes on at placement, so choose wisely.`,
    url: '/book/bounties',
    tag: 'bounty',
  });
}
