/**
 * What a player is worth, in points.
 *
 * The fundamental price is half the weekly projection, so a 20-point stud is
 * a 10-point share, a starter is 5 and a dart throw is 2 -- sized for a league
 * whose balances are in the tens. (It was projection times four at first,
 * which read like a stock chart and priced one share of Gibbs above anyone's
 * whole balance. The percentages are what matter, and those do not change.)
 *
 * During a game the price becomes "what will he finish with", which is the
 * points already scored plus what is still expected -- and the more of the
 * game that has been played, the more his actual pace counts against the
 * pre-game projection. A player at 12 in the first quarter of a 15-point
 * projection is not priced as a 27; he is priced as a player running hot.
 *
 * Pure functions, so the whole model is testable without a feed.
 */
export const POINTS_PER_PROJECTION = 0.5;
export const FLOOR = 0.25;
/**
 * How much of the carried premium survives a week's roll. The whole of last
 * week's surprise folds in at the whistle; a quarter of the running premium
 * then fades, so old surprises are forgotten over a month or so and a price
 * cannot drift away from the projection forever.
 */
export const PREMIUM_DECAY = 0.75;
/** Dividend per share as a share of the week's points: a 20-point week pays 1. */
export const DIVIDEND_RATE = 0.05;

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * How much of a game is still to play, from 1 before kickoff to 0 at final,
 * read off Sleeper's quarter and clock. The Book's `fractionRemaining` steps
 * by quarter, which is right for a market that reprices on a whim and wrong
 * for a stock: a price that only moves four times a game is not a ticker.
 * With the clock, 4:12 left in the first quarter is 0.82 of the game to go.
 */
export function gameRemaining(game) {
  const m = game?.metadata ?? {};
  if (game?.status === 'complete' || m.is_over || m.closed) return 0;
  if (game?.status === 'pre_game' || !m.has_started) return 1;
  if (m.is_overtime) return 0.05;
  const q = Number(m.quarter_num) || Number(m.quarter) || 1;
  const [mm, ss] = String(m.time_remaining ?? '15:00').split(':').map(Number);
  const secs = Number.isFinite(mm) ? mm * 60 + (Number.isFinite(ss) ? ss : 0) : 900;
  const left = 4 - Math.min(4, Math.max(1, q)) + Math.min(900, Math.max(0, secs)) / 900;
  return Math.round(Math.min(1, Math.max(0, left / 4)) * 1000) / 1000;
}

/** True while a game is being played: kicked off and not over. */
export function gameLive(game) {
  const m = game?.metadata ?? {};
  if (!game || game.status === 'pre_game' || !m.has_started) return false;
  return !(game.status === 'complete' || m.is_over || m.closed);
}

export function basePrice(projection, premium = 0) {
  return r2(Math.max(FLOOR, (Number(projection) || 0) * POINTS_PER_PROJECTION + (Number(premium) || 0)));
}

/**
 * The premium a player carries into next week: last week's premium plus the
 * whole of last week's surprise (in price terms), then decayed.
 */
export function rollPremium({ premium = 0, actual = 0, projection = 0 }) {
  const surprise = ((Number(actual) || 0) - (Number(projection) || 0)) * POINTS_PER_PROJECTION;
  return r2(PREMIUM_DECAY * ((Number(premium) || 0) + surprise));
}

/** What a share would pay for a week of `actual` points. */
export function dividendFor(actual) {
  return r2(Math.max(0, Number(actual) || 0) * DIVIDEND_RATE);
}

/**
 * @param projection  pre-game weekly projection
 * @param points      scored so far
 * @param remaining   share of the game still to play, 1 before kickoff, 0 at final
 * @param premium     what earlier weeks' surprises have added, carried in
 */
export function livePrice({ projection, points = 0, remaining = 1, premium = 0 }) {
  const proj = Math.max(0, Number(projection) || 0);
  const pts = Number(points) || 0;
  const rem = Math.min(1, Math.max(0, Number(remaining)));
  const played = 1 - rem;

  // What the projection says is left, and what his own pace says is left.
  const byProjection = pts + rem * proj;
  const pace = played >= 0.25 ? pts / played : proj;
  const byPace = pts + rem * pace;

  // Trust pace more as the game goes on, but never more than half: a hot
  // first half is real information, not a promise.
  const weight = 0.5 * played;
  const finish = (1 - weight) * byProjection + weight * byPace;
  return r2(Math.max(FLOOR, finish * POINTS_PER_PROJECTION + (Number(premium) || 0)));
}
