/**
 * What a player is worth, in points.
 *
 * The fundamental price is the weekly projection scaled up so a starter
 * trades in the tens and a star near a hundred: a 20-point week is an 80
 * stock. During a game the price becomes "what will he finish with", which is
 * the points already scored plus what is still expected -- and the more of the
 * game that has been played, the more his actual pace counts against the
 * pre-game projection. A player at 12 in the first quarter of a 15-point
 * projection is not priced as a 27; he is priced as a player running hot.
 *
 * Pure functions, so the whole model is testable without a feed.
 */
export const POINTS_PER_PROJECTION = 4;
export const FLOOR = 1;

const r2 = (n) => Math.round(n * 100) / 100;

export function basePrice(projection) {
  return r2(Math.max(FLOOR, (Number(projection) || 0) * POINTS_PER_PROJECTION));
}

/**
 * @param projection  pre-game weekly projection
 * @param points      scored so far
 * @param remaining   share of the game still to play, 1 before kickoff, 0 at final
 */
export function livePrice({ projection, points = 0, remaining = 1 }) {
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
  return r2(Math.max(FLOOR, finish * POINTS_PER_PROJECTION));
}
