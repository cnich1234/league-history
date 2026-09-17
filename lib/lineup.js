/**
 * The lineup a matchup is priced on.
 *
 * Every price in The Book -- pregame lines, live h2h, spreads, totals,
 * showdowns -- used to be computed from whatever starters a manager had SET.
 * That handed every manager a lever: empty your lineup on Thursday, watch
 * your own odds balloon, bet on yourself, put the lineup back before Sunday.
 * Devin found it inside a day.
 *
 * So a roster is priced on the lineup it can be EXPECTED to field, not the
 * one currently set:
 *
 *   - a starter whose game has kicked off is locked in Sleeper and counts as
 *     set, points and all;
 *   - every other slot is filled with the best eligible rostered player who
 *     can still be started (his game has not kicked off, he is not on IR).
 *
 * Benching a player before his kickoff therefore changes nothing, because the
 * model assumes you will put him back. The only way to move your own price is
 * to actually field a worse team when the games start, which costs a real
 * league game. That is the one lever worth leaving.
 *
 * A slot NOBODY on the roster can fill -- the defence is on a bye and the
 * waiver claim does not clear until Thursday -- is worth what a pickup would
 * bring: the average of the top five free agents at that position. Zero
 * there punished the bye week twice, once on the field and once on the line.
 *
 * Pure: every feed is passed in as a function, so it is testable in a script.
 */

const FLEX = new Set(['RB', 'WR', 'TE']);
const NOT_A_SLOT = new Set(['BN', 'IR', 'TAXI']);

/** Sleeper's default for this league, if the settings cannot be fetched. */
export const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

const FLEX_POSITIONS = ['RB', 'WR', 'TE'];

/**
 * What an empty slot is worth: the average projection of the best `top`
 * unrostered players at each position. `ids` is every projected player,
 * `rostered` the set anyone in the league holds.
 */
export function replacementTable({ ids, rostered, positionOf, projectionOf, top = 5 }) {
  const byPos = {};
  for (const id of ids) {
    if (rostered.has(String(id))) continue;
    const pos = positionOf(id);
    if (!pos) continue;
    (byPos[pos] ??= []).push(Number(projectionOf(id)) || 0);
  }
  const table = {};
  for (const [pos, values] of Object.entries(byPos)) {
    const best = values.sort((a, b) => b - a).slice(0, top);
    table[pos] = best.length ? Math.round((best.reduce((s, v) => s + v, 0) / best.length) * 10) / 10 : 0;
  }
  return table;
}

/** The replacement value for a slot, given a table from replacementTable. */
export function replacementFor(slot, table = {}) {
  if (slot === 'FLEX') return Math.max(0, ...FLEX_POSITIONS.map((p) => table[p] ?? 0));
  if (slot === 'SUPER_FLEX') return Math.max(0, table.QB ?? 0, ...FLEX_POSITIONS.map((p) => table[p] ?? 0));
  return table[slot] ?? 0;
}

/**
 * Injury statuses that make a player a real risk of not taking the field.
 *
 * Questionable is included deliberately. It is the loosest of them and the most
 * common, and a Questionable player who sits scores zero exactly like an Out
 * one -- a projection cannot express that, so the lineup model must.
 *
 * IR, PUP and NA are absent because those players cannot be started at all and
 * belong in `unavailable`, not here.
 */
export const RISKY_STATUS = new Set(['Questionable', 'Doubtful', 'Out']);

/** True when this status should stop a player displacing a healthy one. */
export function isRisky(status) {
  return Boolean(status) && RISKY_STATUS.has(String(status));
}

export function slotFits(slot, position) {
  if (!position) return false;
  if (slot === 'FLEX') return FLEX.has(position);
  if (slot === 'SUPER_FLEX') return position === 'QB' || FLEX.has(position);
  return slot === position;
}

/**
 * @param matchup      a Sleeper matchup row: starters[], players[], starters_points[]
 * @param slots        the league's roster_positions (bench entries are ignored)
 * @param positionOf   id -> 'QB' | 'RB' | ... | null
 * @param projectionOf id -> expected points this week (0 on a bye)
 * @param kickedOff    id -> true once the player's game has started
 * @param unavailable  ids that cannot be started at all (IR, taxi)
 * @param doubtful     id -> true when his status makes him a real risk of
 *                     not playing (Questionable, Doubtful, Out). Such a player
 *                     is only chosen when the manager himself started him, or
 *                     when nobody healthy fits the slot.
 * @param replacement  a table from replacementTable, for slots nobody can fill
 * @returns one entry per starting slot: { slot, id, locked, index, replacement }
 *          where `index` is the position in matchup.starters for a set
 *          starter (to read starters_points), null otherwise; and
 *          `replacement` is the waiver value of a slot with no id
 */
export function expectedLineup(
  matchup,
  {
    slots = DEFAULT_SLOTS,
    positionOf,
    projectionOf,
    kickedOff = () => false,
    unavailable = new Set(),
    doubtful = () => false,
    replacement = {},
  },
) {
  const starting = slots.filter((s) => !NOT_A_SLOT.has(s));
  const set = (matchup?.starters ?? []).map((x) => (x && x !== '0' ? String(x) : null));
  const pool = [...new Set((matchup?.players ?? []).map(String))].filter(
    (id) => id && id !== '0' && !unavailable.has(id),
  );
  const used = new Set();
  const out = new Array(starting.length).fill(null);

  // Locked starters stay exactly where they are, whatever is on the bench.
  starting.forEach((slot, i) => {
    const id = set[i];
    if (id && kickedOff(id)) {
      used.add(id);
      out[i] = { slot, id, locked: true, index: i, replacement: 0 };
    }
  });

  // The rest are filled with the best available, position slots before FLEX
  // so the flex takes what the fixed slots leave. Ties go to the player
  // currently set there, so an honestly set lineup prices as set.
  const order = starting
    .map((slot, i) => i)
    .filter((i) => !out[i])
    .sort((a, b) => Number(starting[a] === 'FLEX' || starting[a] === 'SUPER_FLEX') - Number(starting[b] === 'FLEX' || starting[b] === 'SUPER_FLEX'));
  const setIds = new Set(set.filter(Boolean));
  for (const i of order) {
    const slot = starting[i];
    let best = null;
    let bestValue = -Infinity;
    let bestRisky = true;
    for (const id of pool) {
      if (used.has(id) || kickedOff(id) || !slotFits(slot, positionOf(id))) continue;
      const value = Number(projectionOf(id)) || 0;
      // A projection does not know whether a man will take the field. Sleeper
      // lists Questionable, Doubtful and Out separately, and a 11.6 projection
      // on a Questionable receiver is not worth more than 10.8 on a healthy
      // one -- he can be inactive and score nothing. So a risky player never
      // DISPLACES a healthy one; he is chosen only when the manager started
      // him himself, or when no healthy player fits the slot at all.
      //
      // Devin started a healthy Emeka Egbuka and the model swapped in a
      // Questionable Alec Pierce for 0.78 points, which is how this was found.
      const risky = doubtful(id) && !setIds.has(id);
      if (risky && !bestRisky) continue;
      const better =
        (!risky && bestRisky) ||
        value > bestValue ||
        (value === bestValue && id === set[i]);
      if (better) {
        best = id;
        bestValue = value;
        bestRisky = risky;
      }
    }
    if (best) used.add(best);
    out[i] = {
      slot,
      id: best,
      locked: false,
      index: best && set[i] === best ? i : null,
      replacement: best ? 0 : replacementFor(slot, replacement),
    };
  }
  return out;
}

/** Just the ids, for callers that only want a set of players. */
export function expectedIds(matchup, opts) {
  return expectedLineup(matchup, opts)
    .map((e) => e.id)
    .filter(Boolean);
}
