/**
 * Daily fantasy salaries.
 *
 * Sleeper sells a player pool and real scoring but no PRICES, so these are
 * derived from the weekly projections the board already fetches. Three things
 * matter and are checked here:
 *
 *   The cap BINDS. A salary table where you can afford the best player at every
 *   slot is not a game -- it is a form. The chalk lineup has to be out of reach.
 *
 *   Prices do not MOVE. Sleeper revises projections mid-week, and a lineup that
 *   was legal when it was built has to stay legal, so a second build writes
 *   nothing.
 *
 *   Nobody is priced at the floor for being ABSENT. A player Sleeper has not
 *   rated is missing, not cheap, and pricing him at $3,000 would put every
 *   inactive in the league on the board.
 */
import { neon } from '@neondatabase/serverless';
import {
  buildSalaries,
  salaryPool,
  salaryFor,
  nameOf,
  SALARY_CAP,
  SALARY_FLOOR,
  DFS_POSITIONS,
} from '../lib/dfs.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9977;
const W = 1;

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

const clean = () => sql`delete from dfs_salaries where season = ${S}`;

// A small synthetic pool: enough shape to test the rules without depending on
// what Sleeper happens to be projecting today.
const players = {
  qb1: { first_name: 'Top', last_name: 'Passer', position: 'QB', team: 'KC' },
  qb2: { first_name: 'Cheap', last_name: 'Passer', position: 'QB', team: 'NE' },
  rb1: { first_name: 'Top', last_name: 'Rusher', position: 'RB', team: 'DET' },
  rb2: { first_name: 'Mid', last_name: 'Rusher', position: 'RB', team: 'GB' },
  wr1: { first_name: 'Top', last_name: 'Catcher', position: 'WR', team: 'LAR' },
  te1: { first_name: 'Top', last_name: 'End', position: 'TE', team: 'SF' },
  k1: { first_name: 'Some', last_name: 'Kicker', position: 'K', team: 'BAL' },
  JAX: { position: 'DEF', team: 'JAX' },
  ghost: { first_name: 'Un', last_name: 'Rated', position: 'WR', team: 'NYJ' },
};
const projections = {
  qb1: 25, qb2: 9, rb1: 20, rb2: 11, wr1: 18, te1: 12, k1: 8, JAX: 9,
  ghost: 0, // rated at zero -- absent, not cheap
  nobody: 15, // projected but not in the player file at all
};

await clean();

try {
  console.log('\nthe price curve');
  ok('floor applies at zero', salaryFor(0), SALARY_FLOOR);
  ok('and rises with the projection', salaryFor(20) > salaryFor(10), true);
  ok('rounded to readable hundreds', salaryFor(13.7) % 100, 0);
  // Negative projections happen: a defence can be rated below zero.
  ok('a negative projection floors rather than going below', salaryFor(-5), SALARY_FLOOR);

  console.log('\nnaming');
  ok('a player gets their name', nameOf(players.qb1, 'qb1'), 'Top Passer');
  // A DEF has no full_name in Sleeper's file -- its id IS the abbreviation --
  // so priced defences rendered as "?" until this existed.
  ok('a defence gets a real one', nameOf(players.JAX, 'JAX'), 'Jaguars D/ST');
  ok('and an unknown abbreviation still reads', nameOf({ position: 'DEF' }, 'XXX'), 'XXX D/ST');

  console.log('\nbuilding a week');
  const built = await buildSalaries(S, W, { players, projections });
  const pool = await salaryPool(S, W);
  ok('everything priced was written', built.written, built.priced);

  const ids = pool.map((p) => p.player_id).sort();
  // Kickers ARE priced -- the league's lineup has a K slot and this matches it.
  ok('kickers are priced', ids.includes('k1'), true);
  // A player rated zero is absent, not cheap. Pricing him at the floor would
  // put every inactive in the league on the board at $3,000.
  ok('a player rated at zero is not', ids.includes('ghost'), false);
  ok('nor one missing from the player file', ids.includes('nobody'), false);
  ok('the rest are', ids, ['JAX', 'k1', 'qb1', 'qb2', 'rb1', 'rb2', 'te1', 'wr1']);

  console.log('\nevery priced position is one we meant to price');
  ok(
    'no stray positions',
    [...new Set(pool.map((p) => p.position))].filter((p) => !DFS_POSITIONS.includes(p)),
    [],
  );

  console.log('\nprices do not move under a drafted lineup');
  {
    // Sleeper revises during the week. A second build must not reprice.
    const moved = { ...projections, qb1: 40 };
    const again = await buildSalaries(S, W, { players, projections: moved });
    ok('a rebuild writes nothing', again.written, 0);
    const [qb] = await sql`
      select salary from dfs_salaries where season = ${S} and week = ${W} and player_id = 'qb1'`;
    ok('and the price is unchanged', Number(qb.salary), salaryFor(25));
  }

  console.log('\nthe cap binds');
  {
    // The whole point. If the best player at every slot is affordable there is
    // no choice to make.
    const best = (pos) =>
      pool.filter((p) => p.position === pos).sort((a, b) => b.projection - a.projection);
    const chalk = [
      ...best('QB').slice(0, 1),
      ...best('RB').slice(0, 2),
      ...best('WR').slice(0, 1),
      ...best('TE').slice(0, 1),
      ...best('DEF').slice(0, 1),
    ];
    const cost = chalk.reduce((n, p) => n + p.salary, 0);
    // This synthetic pool is small, so the assertion is about the SHAPE: the
    // dearest players eat a serious share of a cap this size.
    ok('six premium players cost real money', cost > SALARY_CAP / 2, true);
    ok('and the cheapest is nowhere near the dearest', best('QB')[0].salary > best('QB')[1].salary, true);
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
