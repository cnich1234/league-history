/**
 * The lineup a matchup is priced on.
 *
 * Devin emptied his week 2 lineup on a Tuesday and his own odds went to the
 * moon. Prices now assume the best lineup a roster can still field, so
 * benching before kickoff changes nothing; only a locked starter counts as
 * set. Pure, so this runs without a feed.
 */
import { expectedLineup, expectedIds, slotFits, DEFAULT_SLOTS } from '../lib/lineup.js';
import { sides, sideFinal } from '../lib/live.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` + (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
  if (!match) failed++;
};

// A roster: two QBs, three RBs, four WRs, two TEs, a K and a DEF.
const POS = {
  qb1: 'QB', qb2: 'QB',
  rb1: 'RB', rb2: 'RB', rb3: 'RB',
  wr1: 'WR', wr2: 'WR', wr3: 'WR', wr4: 'WR',
  te1: 'TE', te2: 'TE',
  k1: 'K', def1: 'DEF',
};
const PROJ = {
  qb1: 22, qb2: 15,
  rb1: 18, rb2: 14, rb3: 9,
  wr1: 17, wr2: 13, wr3: 11, wr4: 8,
  te1: 10, te2: 6,
  k1: 8, def1: 7,
};
const roster = Object.keys(POS);
const opts = (extra = {}) => ({
  slots: DEFAULT_SLOTS,
  positionOf: (id) => POS[id] ?? null,
  projectionOf: (id) => PROJ[id] ?? 0,
  ...extra,
});
const best = ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'rb3', 'k1', 'def1'];

console.log('\nslots');
ok('flex takes RB, WR or TE', ['RB', 'WR', 'TE', 'QB', 'K'].map((p) => slotFits('FLEX', p)), [true, true, true, false, false]);
ok('a fixed slot takes only its position', [slotFits('RB', 'RB'), slotFits('RB', 'WR')], [true, false]);
ok('unknown position fits nothing', slotFits('WR', null), false);

console.log('\nan empty lineup is priced on the best one');
{
  const empty = { starters: Array(10).fill('0'), players: roster };
  ok('every slot filled from the roster', expectedIds(empty, opts()), best);
  const entries = expectedLineup(empty, opts());
  ok('nothing counts as set', entries.every((e) => e.locked === false && e.index === null), true);
  ok('flex takes the best leftover, rb3 at 9 over wr4 at 8', entries[7].id, 'rb3');
}

console.log('\nbenching before kickoff changes nothing');
{
  const honest = { starters: best, players: roster };
  ok('an honestly set lineup prices as set', expectedIds(honest, opts()), best);
  const benched = { starters: ['qb2', 'rb3', 'rb2', 'wr4', 'wr2', 'wr3', 'te2', 'wr1', 'k1', 'def1'], players: roster };
  ok('a sandbagged lineup prices as the best one anyway', expectedIds(benched, opts()), best);
  const half = { starters: ['qb1', '0', '0', 'wr1', '0', '0', '0', '0', 'k1', 'def1'], players: roster };
  ok('half-set fills the holes', expectedIds(half, opts()), best);
}

console.log('\nlocked starters are what they are');
{
  // qb2 is set and his game has kicked off: he is locked in, qb1 stays benched.
  const kicked = new Set(['qb2', 'wr4']);
  const lineup = { starters: ['qb2', 'rb1', 'rb2', 'wr4', 'wr2', 'wr3', 'te1', 'rb3', 'k1', 'def1'], players: roster };
  const entries = expectedLineup(lineup, opts({ kickedOff: (id) => kicked.has(id) }));
  ok('the locked QB stays even though a better one sits', entries[0], { slot: 'QB', id: 'qb2', locked: true, index: 0 });
  ok('the locked WR stays', entries[3].id, 'wr4');
  ok('open slots still take the best available', [entries[4].id, entries[5].id], ['wr1', 'wr2']);
  // A bench player whose game has started cannot be started any more.
  const late = { starters: ['qb1', 'rb1', 'rb2', 'wr2', 'wr3', 'wr4', 'te1', 'rb3', 'k1', 'def1'], players: roster };
  const ids = expectedIds(late, opts({ kickedOff: (id) => id === 'wr1' }));
  ok('a kicked-off bench player is not conjured into the lineup', ids.includes('wr1'), false);
}

console.log('\nunavailable players');
{
  const empty = { starters: Array(10).fill('0'), players: roster };
  const ids = expectedIds(empty, opts({ unavailable: new Set(['qb1', 'rb1']) }));
  ok('IR and taxi players are skipped', [ids[0], ids[1], ids[2]], ['qb2', 'rb2', 'rb3']);
  const thin = { starters: Array(10).fill('0'), players: ['qb1', 'rb1', 'wr1'] };
  const entries = expectedLineup(thin, opts());
  ok('a thin roster leaves slots empty rather than inventing players', entries.filter((e) => e.id).length, 3);
}

console.log('\nthe live model uses it');
{
  const done = { status: 'complete', metadata: { is_over: true } };
  const pre = { status: 'pre_game', metadata: { has_started: false } };
  const team = Object.fromEntries(roster.map((id) => [id, id === 'qb2' ? 'KC' : 'BUF']));
  const games = { KC: done, BUF: pre };
  const lineupOpts = { slots: DEFAULT_SLOTS, positionOf: POS };
  // Empty lineup, nothing kicked off: priced on the best lineup's projection.
  const empty = { starters: Array(10).fill('0'), starters_points: [], players: roster };
  const side = sides(empty, PROJ, games, team, lineupOpts);
  ok('an empty lineup projects like the best lineup', side.projected, 22 + 18 + 14 + 17 + 13 + 11 + 10 + 9 + 8 + 7);
  ok('and is not final', sideFinal(side), false);
  ok('and has starters', side.players, 10);
  // Sandbagged QB whose game is over: he is locked in with his points.
  const sandbag = { starters: ['qb2', 'rb1', 'rb2', 'wr1', 'wr2', 'wr3', 'te1', 'rb3', 'k1', 'def1'], starters_points: [4.1, 0, 0, 0, 0, 0, 0, 0, 0, 0], players: roster };
  const s2 = sides(sandbag, PROJ, games, team, lineupOpts);
  ok('a locked bad QB counts as played', [s2.scored, s2.remaining], [4.1, 18 + 14 + 17 + 13 + 11 + 10 + 9 + 8 + 7]);
  // Without lineup options the old behaviour holds, for older callers.
  ok('old callers still price the set starters', sides(empty, PROJ, games, team).projected, 0);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
