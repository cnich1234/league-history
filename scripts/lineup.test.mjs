/**
 * The lineup a matchup is priced on.
 *
 * Devin emptied his week 2 lineup on a Tuesday and his own odds went to the
 * moon. Prices now assume the best lineup a roster can still field, so
 * benching before kickoff changes nothing; only a locked starter counts as
 * set. Pure, so this runs without a feed.
 */
import {
  bestLineupPoints,
  expectedLineup,
  expectedIds,
  slotFits,
  replacementTable,
  replacementFor,
  DEFAULT_SLOTS,
} from '../lib/lineup.js';
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
  ok('the locked QB stays even though a better one sits', entries[0], { slot: 'QB', id: 'qb2', locked: true, index: 0, replacement: 0 });
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

console.log('\na slot nobody can fill is worth a waiver pickup');
{
  // Free agents: five defences worth 9, 8, 7, 6, 5 and a sixth worth 1, two
  // kickers, one rostered defence that must not count.
  const fa = { d1: 9, d2: 8, d3: 7, d4: 6, d5: 5, d6: 1, k9: 7, k8: 5, def1: 99 };
  const faPos = { d1: 'DEF', d2: 'DEF', d3: 'DEF', d4: 'DEF', d5: 'DEF', d6: 'DEF', k9: 'K', k8: 'K', def1: 'DEF' };
  const table = replacementTable({
    ids: Object.keys(fa),
    rostered: new Set(['def1']),
    positionOf: (id) => faPos[id] ?? null,
    projectionOf: (id) => fa[id] ?? 0,
  });
  ok('the top five free agents at a position are averaged', table.DEF, 7);
  ok('fewer than five just averages what there is', table.K, 6);
  ok('rostered players are not free agents', table.DEF < 20, true);
  ok('flex takes the best of RB, WR, TE', replacementFor('FLEX', { RB: 6, WR: 8, TE: 4 }), 8);
  ok('a position with nobody on the wire is worth nothing', replacementFor('QB', table), 0);

  // A roster whose only defence is on a bye: the DEF slot is filled by the wire.
  const byeProj = { ...PROJ, def1: 0 };
  const empty = { starters: Array(10).fill('0'), players: roster };
  const entries = expectedLineup(empty, opts({ projectionOf: (id) => byeProj[id] ?? 0, replacement: table }));
  ok('the bye defence still fills the slot when he is the only one', entries[9].id, 'def1');
  const none = { starters: Array(10).fill('0'), players: roster.filter((id) => id !== 'def1') };
  const e2 = expectedLineup(none, opts({ replacement: table }));
  ok('with no defence at all the slot carries the waiver value', [e2[9].id, e2[9].replacement], [null, 7]);
  ok('a slot that was filled carries no replacement', e2[0].replacement, 0);
  ok('expectedIds ignores waiver fills', expectedIds(none, opts({ replacement: table })).length, 9);
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
  // No defence on the roster at all: the slot is priced at the waiver value.
  const noDef = { starters: Array(10).fill('0'), starters_points: [], players: roster.filter((id) => id !== 'def1') };
  const s3 = sides(noDef, PROJ, games, team, { ...lineupOpts, replacement: { DEF: 7 } });
  ok('a waiver fill counts toward what is to come', s3.remaining, 22 + 18 + 14 + 17 + 13 + 11 + 10 + 9 + 8 + 7);
  ok('and toward the starter count', s3.players, 10);
  const s4 = sides(noDef, PROJ, games, team, lineupOpts);
  ok('without a table the empty slot is worth nothing', s4.players, 9);
}

console.log('\ninjury status does not change the pick');
{
  // Tried the other way on 2026-09-17 and reverted it the same day. Sleeper
  // already discounts a Questionable player's projection for the chance he
  // sits, so preferring a healthy man on top of that prices the same risk
  // twice. Worse, it hands a manager a lever on his own line: an injury
  // designation lands on somebody else's schedule, and his price would move
  // without him touching anything.
  //
  // It also read as arbitrary on the board, which is how it was caught -- one
  // matchup said "odds use Mahomes" and another silently ignored a receiver
  // projected higher, for no reason a reader could see.
  //
  // The rule is the best lineup a roster can field, and "best" is whatever the
  // projection says.
  const set = ['qb1', 'rb1', 'rb2', 'wr2', 'wr3', 'wr4', 'te1', 'rb3', 'k1', 'def1'];
  const ids = expectedIds({ starters: set, players: roster }, opts());
  ok('the better projection starts, injured or not', ids.includes('wr1'), true);
  ok('and the weaker man he set does not', ids.includes('wr4'), false);
}

console.log('\nthe best lineup a roster could have fielded, after the fact');
{
  // Chris R, week 2 of 2026: the trophies called this perfect. Andrews (TE,
  // 10.9) sat while McConkey (WR, 6.5) played the FLEX.
  const chrisR = [
    { position: 'QB', points: 16.8 }, { position: 'RB', points: 17.5 },
    { position: 'RB', points: 7.1 }, { position: 'WR', points: 10 },
    { position: 'WR', points: 7.3 }, { position: 'WR', points: 6.8 },
    { position: 'TE', points: 20.3 }, { position: 'WR', points: 6.5 },
    { position: 'K', points: 17 }, { position: 'DEF', points: 2 },
    // bench
    { position: 'TE', points: 10.9 }, { position: 'RB', points: 6.4 },
    { position: 'WR', points: 5.7 },
  ];
  ok('a benched TE can take the FLEX', bestLineupPoints(chrisR), 115.7);
  ok('which is 4.40 more than he scored', +(bestLineupPoints(chrisR) - 111.3).toFixed(2), 4.4);

  // A QB on the bench cannot fill the FLEX, however many points he scores.
  const qbBench = [
    { position: 'QB', points: 10 }, { position: 'QB', points: 40 },
    { position: 'RB', points: 5 }, { position: 'RB', points: 5 },
    { position: 'WR', points: 5 }, { position: 'WR', points: 5 }, { position: 'WR', points: 5 },
    { position: 'TE', points: 5 }, { position: 'RB', points: 1 },
    { position: 'K', points: 5 }, { position: 'DEF', points: 5 },
  ];
  ok('only the better QB counts; the other cannot flex', bestLineupPoints(qbBench), 81);
  ok('but a SUPER_FLEX takes the second QB over a 1-point RB',
    bestLineupPoints(qbBench, ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'SUPER_FLEX', 'K', 'DEF']), 90);

  // A dedicated slot gets first pick, so the FLEX never steals the only TE.
  const oneTE = [
    { position: 'TE', points: 30 }, { position: 'WR', points: 20 },
    { position: 'WR', points: 10 }, { position: 'WR', points: 9 }, { position: 'WR', points: 8 },
  ];
  ok('FLEX is filled last', bestLineupPoints(oneTE, ['WR', 'WR', 'WR', 'TE', 'FLEX']), 77);

  ok('bench slots are ignored', bestLineupPoints([{ position: 'QB', points: 9 }], ['QB', 'BN', 'BN']), 9);
  ok('an empty slot scores nothing', bestLineupPoints([], ['QB']), 0);
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
