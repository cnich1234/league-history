/**
 * Why did the price move?
 *
 * A price is a pure function of its inputs, so the reason for a move is
 * whichever input changed between two ticks. This diffs a player's track and
 * names each move. A price that changed while no input did is reported as
 * UNEXPLAINED -- that is a bug in the model or the log, and the entire point
 * of keeping the inputs is to make such a thing visible.
 *
 * Pure, so it is testable without a database.
 */
const r2 = (n) => Math.round(n * 100) / 100;
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);

const STATUS_WORDS = {
  'pre>live': 'kickoff',
  'live>final': 'final whistle',
  'pre>final': 'final whistle',
  'none>pre': 'game scheduled',
  'final>pre': 'new week',
  'final>none': 'new week',
};

/** One tick against the one before it. */
export function explainMove(prev, cur) {
  const delta = r2(cur.price - prev.price);
  const move = { t: cur.t, price: cur.price, delta, reason: null, detail: '' };

  if (prev.status == null || cur.status == null) {
    move.reason = delta === 0 ? 'quiet' : 'no inputs';
    move.detail = delta === 0 ? '' : 'recorded before inputs were kept';
    return move;
  }

  const bits = [];
  if (cur.status !== prev.status) {
    move.reason = STATUS_WORDS[`${prev.status}>${cur.status}`] ?? `status ${prev.status} to ${cur.status}`;
    if (cur.status === 'final') bits.push(`settled at ${cur.points} pts`);
  }
  if (!same(cur.points, prev.points)) {
    const d = r2(cur.points - prev.points);
    move.reason ??= d > 0 ? 'scored' : 'stat correction';
    bits.push(`${d > 0 ? '+' : ''}${d} pts (${prev.points} to ${cur.points})`);
  }
  if (!same(cur.projection, prev.projection)) {
    move.reason ??= 'projection revised';
    bits.push(`projection ${prev.projection} to ${cur.projection}`);
  }
  if (!same(cur.premium ?? 0, prev.premium ?? 0)) {
    move.reason ??= 'carried premium';
    bits.push(`carrying ${prev.premium ?? 0} to ${cur.premium ?? 0}`);
  }
  if (!same(cur.remaining, prev.remaining)) {
    move.reason ??= 'clock';
    // Before and after, to a tenth: the feed's clock can jitter by a few
    // seconds while stopped, and two rows both saying "50%" read as a bug.
    const pct = (r) => `${(r * 100).toFixed(1)}%`;
    bits.push(`${pct(prev.remaining)} → ${pct(cur.remaining)} of game left`);
  }
  if (!move.reason) {
    move.reason = delta === 0 ? 'quiet' : 'UNEXPLAINED';
    if (delta !== 0) bits.push('price moved with no input change');
  }
  move.detail = bits.join(' · ');
  return move;
}

/**
 * Every move in a track, newest first. Quiet ticks are dropped unless asked
 * for, since a Sunday has hundreds of them and they say nothing.
 */
export function explainTrack(track, { includeQuiet = false } = {}) {
  const out = [];
  for (let i = 1; i < track.length; i++) {
    const m = explainMove(track[i - 1], track[i]);
    if (includeQuiet || m.reason !== 'quiet') out.push(m);
  }
  return out.reverse();
}

/** The same, as CSV for a spreadsheet. */
export function trackCsv(track) {
  const lines = ['time,price,delta,reason,detail,points,remaining,projection,status'];
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  for (let i = 0; i < track.length; i++) {
    const cur = track[i];
    const m = i ? explainMove(track[i - 1], cur) : { delta: 0, reason: 'first', detail: '' };
    lines.push(
      [
        new Date(cur.t).toISOString(),
        cur.price,
        m.delta,
        q(m.reason),
        q(m.detail),
        cur.points ?? '',
        cur.remaining ?? '',
        cur.projection ?? '',
        cur.status ?? '',
      ].join(','),
    );
  }
  return lines.join('\n');
}
