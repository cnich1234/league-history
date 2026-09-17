/**
 * When each market locks.
 *
 * Rule: bets close at KICKOFF of the earliest game the market depends on.
 *
 * It used to be midnight Arizona on the morning of the game, which was a
 * deliberate simplification and a bad one. On 2026-09-17 the whole Thursday
 * board -- every showdown, spread, prop and special -- was locked at midnight
 * for a game that kicked off at 5:15 that afternoon. Seventeen hours of a
 * betting day gone, on markets whose players had not moved. Nobody could bet
 * the Thursday game on Thursday.
 *
 * A single league-wide lock is wrong in both directions -- locking everything
 * at Thursday kickoff freezes Sunday bets four days early, and locking
 * everything Sunday lets someone bet a Thursday game that has already been
 * played. So each market locks at its own game's kickoff, and a market that
 * spans several games (a matchup whose starters play Thursday and Sunday)
 * locks at the earliest of them.
 *
 * Kickoff times come from the scores feed, which carries `start_time` as an
 * epoch. The schedule feed has only a date, which is what led to the midnight
 * rule in the first place. When the scores feed cannot be reached we fall back
 * to the old midnight instant rather than leaving a market unlocked: an early
 * lock costs a betting window, a late one lets somebody bet a result they have
 * already watched.
 */

const AZ_OFFSET_HOURS = 7; // UTC-7, year round: Arizona does not observe DST.

/**
 * "2026-09-20" -> the UTC instant of midnight Arizona time that morning.
 *
 * The old lock rule, kept only as the fallback for a game whose kickoff the
 * feed did not give us. Locking early is the safe direction to fail.
 */
export function lockInstantFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, AZ_OFFSET_HOURS, 0, 0, 0));
}

/**
 * Every NFL team's game for a week:
 *   { KC: { date: "2026-09-20", kickoff: Date }, ... }
 *
 * `date` is what the UI labels a player's day with; `kickoff` is what a lock
 * is set to. A game with no usable start time carries a null kickoff and falls
 * back to its date's midnight.
 */
export async function teamGameDates(season, week) {
  const [schedule, scores] = await Promise.all([
    fetch(`https://api.sleeper.com/schedule/nfl/regular/${season}`).then((r) => {
      if (!r.ok) throw new Error(`schedule -> ${r.status}`);
      return r.json();
    }),
    // Best effort: without it every game falls back to midnight, which is the
    // behaviour we are replacing but still safer than not locking at all.
    fetch(`https://api.sleeper.com/scores/nfl/regular/${season}/${week}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const kickoffByGame = {};
  if (scores) {
    for (const g of Array.isArray(scores) ? scores : Object.values(scores)) {
      const ms = Number(g?.start_time);
      const key = g?.metadata?.game_key ?? g?.game_id;
      if (key && Number.isFinite(ms) && ms > 0) kickoffByGame[String(key)] = new Date(ms);
    }
  }

  const byTeam = {};
  for (const g of schedule.filter((x) => x.week === week)) {
    const kickoff = kickoffByGame[String(g.game_id)] ?? null;
    const entry = { date: g.date, kickoff };
    byTeam[g.home] = entry;
    byTeam[g.away] = entry;
  }
  return byTeam;
}

/** The instant a team's game starts, or midnight on its game day if unknown. */
function lockFor(entry) {
  if (!entry) return null;
  if (entry.kickoff instanceof Date && !Number.isNaN(entry.kickoff.getTime())) return entry.kickoff;
  return entry.date ? lockInstantFor(entry.date) : null;
}

/**
 * When a market locks, given the NFL teams whose players it depends on.
 *
 * The earliest kickoff wins: if ANY player the market depends on has already
 * taken the field, the bet is no longer honest. One Thursday starter closes
 * the whole matchup at Thursday kickoff -- that is the rule, not an edge case.
 *
 * Teams on a bye contribute nothing rather than pushing the lock later.
 */
export function lockTimeFor(nflTeams, gameDates, fallback) {
  const times = [...new Set(nflTeams)]
    .map((t) => lockFor(gameDates?.[t]))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return times.length ? times[0] : fallback;
}

/** The last kickoff of a week, for markets that belong to no single game. */
export function latestKickoff(gameDates) {
  const times = Object.values(gameDates ?? {})
    .map(lockFor)
    .filter(Boolean)
    .sort((a, b) => a - b);
  return times.length ? times[times.length - 1] : null;
}

/** A team's game day as a plain "YYYY-MM-DD", for labelling. */
export function gameDayFor(gameDates, team) {
  return gameDates?.[team]?.date ?? null;
}
