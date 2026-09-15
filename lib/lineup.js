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
 * Pure: every feed is passed in as a function, so it is testable in a script.
 */

const FLEX = new Set(['RB', 'WR', 'TE']);
const NOT_A_SLOT = new Set(['BN', 'IR', 'TAXI']);

/** Sleeper's default for this league, if the settings cannot be fetched. */
export const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

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
 * @returns one entry per starting slot: { slot, id, locked, index }
 *          where `index` is the position in matchup.starters for a locked
 *          starter (to read starters_points), and null otherwise
 */
export function expectedLineup(
  matchup,
  { slots = DEFAULT_SLOTS, positionOf, projectionOf, kickedOff = () => false, unavailable = new Set() },
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
      out[i] = { slot, id, locked: true, index: i };
    }
  });

  // The rest are filled with the best available, position slots before FLEX
  // so the flex takes what the fixed slots leave. Ties go to the player
  // currently set there, so an honestly set lineup prices as set.
  const order = starting
    .map((slot, i) => i)
    .filter((i) => !out[i])
    .sort((a, b) => Number(starting[a] === 'FLEX' || starting[a] === 'SUPER_FLEX') - Number(starting[b] === 'FLEX' || starting[b] === 'SUPER_FLEX'));
  for (const i of order) {
    const slot = starting[i];
    let best = null;
    let bestValue = -Infinity;
    for (const id of pool) {
      if (used.has(id) || kickedOff(id) || !slotFits(slot, positionOf(id))) continue;
      const value = Number(projectionOf(id)) || 0;
      if (value > bestValue || (value === bestValue && id === set[i])) {
        best = id;
        bestValue = value;
      }
    }
    if (best) used.add(best);
    out[i] = { slot, id: best, locked: false, index: best && set[i] === best ? i : null };
  }
  return out;
}

/** Just the ids, for callers that only want a set of players. */
export function expectedIds(matchup, opts) {
  return expectedLineup(matchup, opts)
    .map((e) => e.id)
    .filter(Boolean);
}
