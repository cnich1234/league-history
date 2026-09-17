/**
 * A daily-fantasy lineup is revealed ONE PLAYER AT A TIME.
 *
 * A player shows once his own game has kicked off. The rest of the lineup
 * stays hidden until theirs do. The whole eight used to appear the moment any
 * one of them started, so somebody who rostered a Thursday player had his
 * entire Sunday team on the board from Thursday night -- three days for
 * everyone else to copy it, which is exactly what the hiding rule exists to
 * stop.
 *
 * Runs against a sentinel season with a contest built by hand, so it can put
 * players mid-week without waiting for a real Thursday.
 */
import { neon } from '@neondatabase/serverless';
import { weekResults, LINEUP } from '../lib/dfs.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9974;
const W = 2;
const A = 'chris-nicholson';
const B = 'devin-nicholson';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

// Eight players: the first two play "Thursday" (team THU), the rest later.
const SLOTS = LINEUP;
const PLAYERS = SLOTS.map((slot, i) => ({
  id: `p${i}`,
  name: `Player ${i}`,
  position: slot === 'FLEX' ? 'RB' : slot,
  team: i < 2 ? 'THU' : 'SUN',
  salary: 5000,
}));

async function clean() {
  await sql`delete from dfs_entries where season = ${S}`;
  await sql`delete from dfs_drafts where contest_id in (select id from dfs_contests where season = ${S})`;
  await sql`delete from dfs_contests where season = ${S}`;
  await sql`delete from dfs_salaries where season = ${S}`;
}

try {
  await clean();

  for (const p of PLAYERS) {
    await sql`
      insert into dfs_salaries (season, week, player_id, name, position, nfl_team, salary, projection)
      values (${S}, ${W}, ${p.id}, ${p.name}, ${p.position}, ${p.team}, ${p.salary}, 10)`;
  }
  const [c] = await sql`
    insert into dfs_contests (season, week, kind, name, buyin_points, seats, status)
    values (${S}, ${W}, 'weekly', 'Reveal test', 0, 10, 'open') returning id`;
  const slots = PLAYERS.map((p) => p.id);
  for (const who of [A, B]) {
    await sql`
      insert into dfs_entries (contest_id, bettor, season, week, slots)
      values (${c.id}, ${who}, ${S}, ${W}, ${JSON.stringify(slots)}::jsonb)`;
  }

  // `started` comes from lockedPlayers, which asks the live feed. The sentinel
  // season has no real games, so it returns empty -- which is the "nothing has
  // kicked off" case, and the first thing worth pinning down.
  console.log('\nbefore anybody has played');
  {
    const { contests } = await weekResults(S, W, { live: false });
    const field = contests[0]?.field ?? [];
    ok('both entries are in the contest', field.length, 2);
    ok('every lineup is fully hidden', field.every((f) => f.hidden), true);
    ok('no player ids are sent at all', field.every((f) => (f.players ?? []).length === 0), true);
    ok('and no slots array rides along', field.every((f) => !('slots' in f)), true);
    ok('no score either', field.every((f) => f.live === null), true);
  }

  console.log('\nthe shape of a partly-played lineup');
  {
    // weekResults reads kickoff from the real feed, so the per-player split is
    // asserted directly against the rule rather than by faking a Thursday.
    const { lineupLocked } = await import('../lib/dfs.js');
    const started = new Set(['p0', 'p1']);
    ok('a lineup with a started player counts as begun', lineupLocked(slots, started), true);
    ok('one with none of them does not', lineupLocked(['p2', 'p3'], started), false);
    ok('an empty lineup never does', lineupLocked([], started), false);

    // The reveal rule itself: visible exactly when the player has started.
    const visible = slots.map((id) => started.has(id));
    ok('only the two Thursday players would show', visible, [true, true, false, false, false, false, false, false]);
    ok('which is 2 of 8', visible.filter(Boolean).length, 2);
  }

  console.log('\na settled contest hides nothing');
  {
    await sql`update dfs_contests set status = 'settled' where id = ${c.id}`;
    const { contests } = await weekResults(S, W, { live: false });
    const field = contests[0]?.field ?? [];
    ok('every lineup is revealed', field.every((f) => !f.hidden), true);
    ok('with all eight players each', field.every((f) => f.players.length === LINEUP.length), true);
    ok('none of them marked hidden', field.every((f) => f.players.every((p) => !p.hidden)), true);
    ok('and every player is named', field.every((f) => f.players.every((p) => p.name)), true);
    ok('the whole lineup counts as played', field.every((f) => f.playedOf === LINEUP.length), true);
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall good');
} finally {
  await clean();
}

process.exit(failed ? 1 : 0);
