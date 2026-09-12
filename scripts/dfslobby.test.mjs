/**
 * Lobbies and settlement -- the half where points actually move.
 *
 * The two kinds differ in exactly one way and it is the important one:
 *
 *   weekly  MINTS points off the placement curve. New money.
 *   lobby   RECYCLES an escrowed pot. Net zero however it finishes, which is
 *           what makes lobbies safe to tune freely.
 *
 * Ties are where a payout curve usually leaks. Two managers tied for first must
 * not both take 20 -- that mints 40 where the curve promised 37 -- so a tie
 * splits the places it spans.
 */
import { neon } from '@neondatabase/serverless';
import {
  buildSalaries,
  salaryPool,
  openLobby,
  openLobbies,
  enterContest,
  settleContest,
  voidLobby,
  weeklyContest,
  contestField,
  lineupLocked,
  lockDueContests,
  settleWeek,
  PLACE_POINTS,
} from '../lib/dfs.js';
import { getPoints } from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9976;
const W = 3;
const A = 'chris-nicholson';
const B = 'devin-nicholson';
const C = 'brandon-lowe';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};
const rejects = async (label, fn, fragment) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a rejection)`);
    failed++;
  } catch (e) {
    const hit = !fragment || e.message.toLowerCase().includes(fragment.toLowerCase());
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${label}${hit ? '' : `: ${e.message}`}`);
    if (!hit) failed++;
  }
};

async function clean() {
  await sql`delete from dfs_entries where season = ${S}`;
  await sql`delete from dfs_contests where season = ${S}`;
  await sql`delete from dfs_salaries where season = ${S}`;
  await sql`delete from point_ledger where season = ${S}`;
}
const pts = (slug, n) => sql`
  insert into point_ledger (bettor, season, amount, reason, note)
  values (${slug}, ${S}, ${n}, 'adjustment', 'dfs lobby test')`;

// A pool deep enough to fill ten slots several different ways.
const players = {};
const projections = {};
for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
  for (let i = 0; i < 8; i++) {
    const id = `${pos}${i}`;
    players[id] =
      pos === 'DEF'
        ? { position: 'DEF', team: 'JAX' }
        : { first_name: pos, last_name: String(i), position: pos, team: 'KC' };
    projections[id] = Math.max(1, 20 - i * 2.7);
  }
}

await clean();

try {
  for (const w of [A, B, C]) await pts(w, 200);
  await buildSalaries(S, W, { players, projections });
  const pool = await salaryPool(S, W);
  const cheap = (pos) => pool.filter((p) => p.position === pos).sort((a, b) => a.salary - b.salary);

  // Distinct legal lineups that all stay under the cap.
  //
  // Only the QB varies: stepping every slot deeper made higher variants
  // progressively dearer until they broke the cap, which failed the test for
  // the fixture's reasons rather than the code's. One swapped player is enough
  // to make the scores differ.
  const lineup = (n) => [
    cheap('QB')[n].player_id,
    cheap('RB')[0].player_id,
    cheap('RB')[1].player_id,
    cheap('WR')[0].player_id,
    cheap('WR')[1].player_id,
    cheap('WR')[2].player_id,
    cheap('TE')[0].player_id,
    cheap('RB')[2].player_id,
    cheap('K')[0].player_id,
    cheap('DEF')[0].player_id,
  ];

  console.log('\nopening a lobby');
  const lobby = await openLobby({
    slug: A,
    season: S,
    week: W,
    name: 'Test lobby',
    seats: 3,
    buyinPoints: 10,
  });
  ok('it is a lobby', lobby.kind, 'lobby');
  ok('with the seats asked for', Number(lobby.seats), 3);
  ok('and it is listed', (await openLobbies(S, W)).length, 1);
  ok('with nobody in it yet', (await openLobbies(S, W))[0].seats_taken, 0);

  console.log('\nlobby rules');
  await rejects(
    'one seat is not a contest',
    () => openLobby({ slug: A, season: S, week: W, seats: 1, buyinPoints: 5 }),
    'between 2 and 10',
  );
  await rejects(
    'nor is eleven',
    () => openLobby({ slug: A, season: S, week: W, seats: 11, buyinPoints: 5 }),
    'between 2 and 10',
  );
  await rejects(
    'a free lobby is not a lobby',
    () => openLobby({ slug: A, season: S, week: W, seats: 3, buyinPoints: 0 }),
    'at least 1',
  );
  await rejects(
    'and you cannot open one you cannot sit in',
    () => openLobby({ slug: A, season: S, week: W, seats: 3, buyinPoints: 9999 }),
    'you have',
  );

  console.log('\nbuying in escrows the points');
  {
    const before = await getPoints(A, S);
    await enterContest({
      slug: A, contestId: Number(lobby.id), slots: lineup(0), season: S, week: W,
    });
    ok('charged the buy-in', before - (await getPoints(A, S)), 10);

    // Editing is free -- charging again would cost points for changing your mind.
    const mid = await getPoints(A, S);
    await enterContest({
      slug: A, contestId: Number(lobby.id), slots: lineup(1), season: S, week: W,
    });
    ok('editing costs nothing', await getPoints(A, S), mid);
    ok('and there is still one entry', (await contestField(Number(lobby.id))).length, 1);
  }

  console.log('\nthe lobby fills');
  {
    await enterContest({
      slug: B, contestId: Number(lobby.id), slots: lineup(2), season: S, week: W,
    });
    await enterContest({
      slug: C, contestId: Number(lobby.id), slots: lineup(3), season: S, week: W,
    });
    const [live] = await openLobbies(S, W);
    ok('three seats taken', live.seats_taken, 3);
    ok('and the pot is the sum of the buy-ins', live.pot, 30);
  }

  console.log('\nand then it is full');
  await rejects(
    'a fourth is turned away',
    () =>
      enterContest({
        slug: 'mike-brown', contestId: Number(lobby.id), slots: lineup(0), season: S, week: W,
      }),
    'full',
  );

  console.log('\nsettling a lobby recycles the pot');
  {
    // A is on lineup(1) after editing, and scores most.
    const scores = {};
    for (const id of lineup(1)) scores[id] = 10;
    for (const id of lineup(2)) scores[id] = 5;
    for (const id of lineup(3)) scores[id] = 1;
    const before = {
      A: await getPoints(A, S), B: await getPoints(B, S), C: await getPoints(C, S),
    };
    const res = await settleContest(Number(lobby.id), { points: scores });

    ok('everyone was scored', res.settled, 3);
    ok('one winner paid', res.paid.length, 1);
    ok('who takes the whole pot', res.paid[0].points, 30);
    ok('and it is the top score', res.paid[0].bettor, A);
    ok('the winner banks the pot', (await getPoints(A, S)) - before.A, 30);
    ok('B is unchanged at settlement', (await getPoints(B, S)) - before.B, 0);
    ok('and so is C', (await getPoints(C, S)) - before.C, 0);

    // The whole point of a lobby: the buy-ins came back out, nothing more.
    const moved =
      (await getPoints(A, S)) - before.A +
      ((await getPoints(B, S)) - before.B) +
      ((await getPoints(C, S)) - before.C);
    ok('exactly the pot moved, nothing minted', moved, 30);
  }

  console.log('\nsettling twice does nothing');
  {
    const before = await getPoints(A, S);
    const again = await settleContest(Number(lobby.id));
    ok('refused', again.note, 'already settled');
    ok('and nobody was paid twice', await getPoints(A, S), before);
  }

  console.log('\nan unfilled lobby refunds');
  {
    const dud = await openLobby({
      slug: A, season: S, week: W, name: 'Dud', seats: 4, buyinPoints: 8,
    });
    await enterContest({
      slug: A, contestId: Number(dud.id), slots: lineup(0), season: S, week: W,
    });
    await enterContest({
      slug: B, contestId: Number(dud.id), slots: lineup(1), season: S, week: W,
    });
    const before = { A: await getPoints(A, S), B: await getPoints(B, S) };
    const n = await voidLobby(Number(dud.id), 'it never filled');
    ok('both refunded', n, 2);
    ok('A is whole', (await getPoints(A, S)) - before.A, 8);
    ok('B is whole', (await getPoints(B, S)) - before.B, 8);
    ok('and it is off the list', (await openLobbies(S, W)).length, 0);
  }

  console.log('\nthe weekly MINTS instead');
  {
    const weekly = await weeklyContest(S, W);
    await enterContest({
      slug: A, contestId: Number(weekly.id), slots: lineup(0), season: S, week: W,
    });
    await enterContest({
      slug: B, contestId: Number(weekly.id), slots: lineup(1), season: S, week: W,
    });

    const scores = {};
    for (const id of lineup(0)) scores[id] = 10;
    for (const id of lineup(1)) scores[id] = 2;
    const before = { A: await getPoints(A, S), B: await getPoints(B, S) };
    const res = await settleContest(Number(weekly.id), { points: scores });

    ok('both scored', res.settled, 2);
    ok('first takes the top of the curve', (await getPoints(A, S)) - before.A, PLACE_POINTS[0]);
    ok('second takes the next', (await getPoints(B, S)) - before.B, PLACE_POINTS[1]);
  }

  console.log('\na tie splits rather than paying twice');
  {
    const tie = await openLobby({
      slug: A, season: S, week: W, name: 'Tie', seats: 2, buyinPoints: 7,
    });
    await enterContest({
      slug: B, contestId: Number(tie.id), slots: lineup(0), season: S, week: W,
    });
    await enterContest({
      slug: C, contestId: Number(tie.id), slots: lineup(1), season: S, week: W,
    });
    const scores = {};
    for (const id of [...lineup(0), ...lineup(1)]) scores[id] = 4;
    const before = { B: await getPoints(B, S), C: await getPoints(C, S) };
    const res = await settleContest(Number(tie.id), { points: scores });

    ok('two winners', res.paid.length, 2);
    // Pot is 14 (2 x 7). Split, with the odd point to the earliest entrant, so
    // the parts add back to the pot exactly.
    ok('the whole pot goes out', res.paid.reduce((n, p) => n + p.points, 0), 14);
    ok(
      'and neither is short-changed',
      (await getPoints(B, S)) - before.B + ((await getPoints(C, S)) - before.C),
      14,
    );
  }
  console.log('\nper-player locking');
  {
    // A lineup is editable while every player in it is yet to play. One
    // started player freezes the whole thing, because a swap after that is
    // made knowing something -- a lineup is one bet, not ten.
    const l = lineup(0);
    ok('nothing started, nothing locked', lineupLocked(l, new Set()), false);
    ok('one started player freezes it', lineupLocked(l, new Set([l[4]])), true);
    ok('somebody else starting does not', lineupLocked(l, new Set(['nobody'])), false);
    ok('an empty lineup is not locked', lineupLocked([], new Set([l[0]])), false);
  }

  console.log('\nan unfilled lobby is voided rather than locked');
  {
    // Three seats, two entrants. It cannot settle against the field people
    // paid to join, so everyone is refunded instead of one of them winning a
    // short pot.
    const short = await openLobby({
      slug: A, season: S, week: W, name: 'Short', seats: 3, buyinPoints: 6,
    });
    await enterContest({
      slug: A, contestId: Number(short.id), slots: lineup(0), season: S, week: W,
    });
    await enterContest({
      slug: B, contestId: Number(short.id), slots: lineup(1), season: S, week: W,
    });
    const before = { A: await getPoints(A, S), B: await getPoints(B, S) };

    const n = await voidLobby(Number(short.id), 'it never filled');
    ok('both were refunded', n, 2);
    ok('A is whole', (await getPoints(A, S)) - before.A, 6);
    ok('B is whole', (await getPoints(B, S)) - before.B, 6);
    const [row] = await sql`select status from dfs_contests where id = ${Number(short.id)}`;
    ok('and it is void, not settled', row.status, 'void');
  }

  console.log('\nsettleWeek only touches locked contests');
  {
    const open = await openLobby({
      slug: A, season: S, week: W, name: 'Still open', seats: 2, buyinPoints: 3,
    });
    await enterContest({
      slug: A, contestId: Number(open.id), slots: lineup(0), season: S, week: W,
    });
    await enterContest({
      slug: B, contestId: Number(open.id), slots: lineup(1), season: S, week: W,
    });

    // Nothing is locked, so nothing settles -- an open contest is still being
    // edited and settling it would pay out a lineup somebody meant to change.
    const none = await settleWeek(S, W);
    ok('an open contest is left alone', none.contests, 0);
    const [still] = await sql`select status from dfs_contests where id = ${Number(open.id)}`;
    ok('and stays open', still.status, 'open');
  }

} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
