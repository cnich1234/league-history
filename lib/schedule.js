/**
 * When each market locks.
 *
 * Rule: bets close at midnight Arizona time on the morning of the game.
 *
 * A single league-wide lock is wrong in both directions -- locking everything
 * at Thursday kickoff freezes Sunday bets four days early, and locking
 * everything Sunday lets someone bet a Thursday game that has already been
 * played. So each market locks on its own game day, and a market that spans
 * several days (a matchup whose starters play Thursday and Sunday) locks on the
 * earliest of them.
 *
 * Arizona does not observe daylight saving, so the offset is a constant -07:00
 * all season. That is the whole reason this file is thirty lines instead of a
 * timezone library: no DST boundary to get wrong in December.
 */

const AZ_OFFSET_HOURS = 7; // UTC-7, year round

/** "2026-09-20" -> the UTC instant of midnight Arizona time that morning. */
export function lockInstantFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Midnight in Arizona is 07:00 UTC the same calendar day.
  return new Date(Date.UTC(y, m - 1, d, AZ_OFFSET_HOURS, 0, 0, 0));
}

/** Every NFL team's game date for a week: { KC: "2026-09-20", ... } */
export async function teamGameDates(season, week) {
  const res = await fetch(`https://api.sleeper.com/schedule/nfl/regular/${season}`);
  if (!res.ok) throw new Error(`schedule -> ${res.status}`);
  const games = (await res.json()).filter((g) => g.week === week);
  const byTeam = {};
  for (const g of games) {
    byTeam[g.home] = g.date;
    byTeam[g.away] = g.date;
  }
  return byTeam;
}

/**
 * When a market locks, given the NFL teams whose players it depends on.
 *
 * The earliest game day wins: a matchup market must close before any of its
 * starters plays, or that player's result is already known when someone bets.
 * Teams on a bye contribute nothing rather than pushing the lock later.
 */
export function lockTimeFor(nflTeams, gameDates, fallback) {
  const dates = [...new Set(nflTeams)].map((t) => gameDates[t]).filter(Boolean);
  if (!dates.length) return fallback;
  return lockInstantFor(dates.sort()[0]);
}
