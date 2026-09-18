/**
 * Props on players who will not take the field.
 *
 * Nico Collins was ruled Out with a hamstring strain and his over/under stayed
 * open, taking bets until Sunday. A prop on a man who is not playing has no
 * honest answer: the over cannot win, and the under is free money for whoever
 * read the injury report first. Eleven such props were open on the week 2
 * board, and one already had a parlay leg on the under.
 *
 * So a scratched player's prop is VOIDED rather than locked. Locking would
 * leave it to settle at zero on Tuesday, paying everyone who took the under
 * for a result nobody had to predict. Voiding refunds every stake and kills
 * the leg, which is what settleMarket(id, 'void') already does -- its own
 * comment names this exact case, it just never ran automatically.
 *
 * WHAT COUNTS AS NOT PLAYING. Out, Doubtful, IR, PUP, NA, Suspended, COV and
 * DNR. Questionable is deliberately absent: it is the loosest designation and
 * the most common (74 players league-wide against 5 Doubtful), most of them
 * play, and voiding on it would cancel half the board every week. A
 * Questionable player who then sits is a bad beat, which is football.
 *
 * Doubtful IS included. Sleeper uses it sparingly and it nearly always means
 * out; a market that cannot be priced honestly is worse than one voided in
 * error, because the error refunds and the other pays somebody for nothing.
 */

/** Designations that mean the man is not playing this week. */
export const SCRATCHED = new Set([
  'Out',
  'Doubtful',
  'IR',
  'PUP',
  'NA',
  'Suspended',
  'Sus',
  'COV',
  'DNR',
]);

export function isScratched(status) {
  return Boolean(status) && SCRATCHED.has(String(status));
}

/**
 * Every open prop whose player is scratched, as { id, title, playerName,
 * status }.
 *
 * `players` is Sleeper's player map. Markets are read by the caller so this
 * stays pure and testable -- the decision is the interesting part, not the
 * query.
 */
export function scratchedProps(markets, players) {
  const out = [];
  for (const m of markets) {
    if (m.kind !== 'prop' || m.status !== 'open') continue;
    const id = m.meta?.playerId;
    if (id == null) continue;
    const p = players[String(id)];
    const status = p?.injury_status ?? null;
    if (!isScratched(status)) continue;
    out.push({
      id: Number(m.id),
      title: m.title,
      playerName: m.meta?.playerName ?? p?.full_name ?? String(id),
      status,
    });
  }
  return out;
}

/* ---------- the sweep ---------- */

const PLAYER_FILE = 'https://api.sleeper.app/v1/players/nfl';
// The player file is 15MB, so it is pulled at most every ten minutes rather
// than on every heartbeat. Injury news does not land more often than that, and
// a prop voided ten minutes late is still voided days before the game.
const TTL = 10 * 60_000;
let cache = { at: 0, promise: null };

function playerFile() {
  if (cache.promise && Date.now() - cache.at < TTL) return cache.promise;
  cache = { at: Date.now(), promise: fetch(PLAYER_FILE).then((r) => r.json()) };
  cache.promise.catch(() => {
    cache = { at: 0, promise: null };
  });
  return cache.promise;
}

/** For tests, and for a caller that wants a fresh read. */
export function forgetPlayers() {
  cache = { at: 0, promise: null };
}

/**
 * Voids every open prop whose player has been ruled out, refunding stakes and
 * killing parlay legs. Returns what it voided.
 *
 * Idempotent: a voided market is no longer 'open', so a second run finds
 * nothing. Safe to call from the per-minute tick.
 */
export async function voidScratchedProps(season, week, { sql, settleMarket } = {}) {
  if (!sql || !settleMarket) throw new Error('voidScratchedProps needs sql and settleMarket.');
  const markets = await sql`
    select id, kind, title, status, meta from markets
    where season = ${season} and week = ${week} and kind = 'prop' and status = 'open'`;
  if (!markets.length) return [];

  const players = await playerFile().catch(() => null);
  if (!players) return [];

  const doomed = scratchedProps(markets, players);
  const done = [];
  for (const m of doomed) {
    // settleMarket(id, 'void') refunds every stake, voids every parlay leg and
    // refunds any bounty riding on those bets. One failure must not stop the
    // rest: a market left open is the thing being fixed.
    try {
      await settleMarket(m.id, 'void');
      done.push(m);
    } catch {
      /* next market */
    }
  }
  return done;
}
