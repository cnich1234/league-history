/**
 * Locking: which markets stop taking bets, and when.
 *
 * This exists because `lockDueMarkets` was dead code -- nothing in the app ever
 * called it, so no market in the season had ever left 'open'. Two separate
 * things were riding on a status that never changed: the betting guard in
 * placeBet/placeParlay, and The Floor's rule for revealing other people's bets.
 *
 * Since live betting there is only one clock-based lock left: a player prop, at
 * its own player's kickoff. h2h, spread and team total are all live -- they keep
 * trading, repriced from the game state, until the result is no longer in doubt.
 * shouldSuspend decides that, not a timestamp.
 *
 * So locks_at is not a deadline for a live market at all, only the moment
 * pricing switches from the posted line to the live model.
 */
import { neon } from '@neondatabase/serverless';
import { lockDueMarkets, visibleBets, getOpenMarkets } from '../lib/book.js';
import { finishedRostersIn } from '../lib/live.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9995;
const HOME = 1;
const AWAY = 2;

let failed = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}\n         expected ${e}\n         got      ${a}`);
    failed++;
  }
};

const statusOf = async (id) =>
  (await sql`select status from markets where id = ${id}`)[0]?.status;

async function makeMarket({ live, locked, kind = 'h2h', meta }) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, live, meta)
    values (${TEST_SEASON}, 1, ${kind}, ${'LOCK TEST ' + Math.random()},
            ${locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3)},
            ${live},
            ${JSON.stringify(
              meta ?? { homeRoster: HOME, awayRoster: AWAY, homeSlug: 'a', awaySlug: 'b' },
            )}::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', -110), (${m.id}, 'away', 'Away', -110)`;
  return Number(m.id);
}

async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  if (ids.length) {
    await sql`delete from ledger where bet_id in (select id from bets where market_id = any(${ids}))`;
    await sql`delete from bets where market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
}

await cleanup();

try {
  console.log('\nnothing locks without kickoff or final information');
  // Not knowing is never a reason to close a market. An open market is still
  // governed by shouldSuspend at pricing time, so nothing can be bet at a
  // decided price either way.
  const plainDue = await makeMarket({ live: false, locked: true });
  const plainFuture = await makeMarket({ live: false, locked: false });
  await lockDueMarkets([], []);
  check('a prop past its posted time stays open', await statusOf(plainDue), 'open');
  check('and one still to come stays open', await statusOf(plainFuture), 'open');

  console.log('\na live market does NOT lock on its posted time');
  // The whole point of a live market. Closing it here would shut every in-play
  // market the moment kickoff passed -- and a matchup with one Thursday starter
  // would go dark all weekend while most of both lineups had yet to play.
  const liveDue = await makeMarket({ live: true, locked: true });
  await lockDueMarkets([], ['NE', 'SEA', 'SF', 'LAR']);
  check('stays open past its lock', await statusOf(liveDue), 'open');
  check('and kickoff does not touch it', await statusOf(liveDue), 'open');

  console.log('\na live market locks when its game is over');
  await lockDueMarkets([HOME]);
  check('one side final is not enough', await statusOf(liveDue), 'open');
  await lockDueMarkets([HOME, AWAY]);
  check('both sides final closes it', await statusOf(liveDue), 'locked');

  console.log('\na team total closes on its own roster alone');
  const total = await makeMarket({
    live: true,
    locked: true,
    kind: 'total',
    meta: { rosterId: AWAY, line: 120 },
  });
  await lockDueMarkets([HOME]);
  check('a different roster finishing does nothing', await statusOf(total), 'open');
  await lockDueMarkets([AWAY]);
  check('its own roster finishing closes it', await statusOf(total), 'locked');

  console.log('\nrepeat runs are safe');
  const before = await sql`
    select id, status from markets where season = ${TEST_SEASON} order by id`;
  const again = await lockDueMarkets([HOME, AWAY], ['NE', 'SEA', 'SF', 'LAR']);
  check('nothing left to lock', again.length, 0);
  const after = await sql`
    select id, status from markets where season = ${TEST_SEASON} order by id`;
  check('statuses unchanged', after, before);

  console.log('\nthe open board keeps live markets past their lock');
  // getOpenMarkets filtered on `locks_at > now()` with no live exception, which
  // dropped exactly the markets that were most active.
  const liveOpen = await makeMarket({ live: true, locked: true });
  const openIds = (await getOpenMarkets(TEST_SEASON, 1)).map((m) => Number(m.id));
  check('a live market past its lock is on the board', openIds.includes(liveOpen), true);
  check('an unlocked prop is', openIds.includes(plainFuture), true);

  console.log('\nThe Floor reveals a live bet only once locked');
  const [bettor] = await sql`select slug from bettors limit 1`;
  const [bet] = await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds, status)
    values (${bettor.slug}, ${liveOpen}, 'home', 2500, -110, 'pending')
    returning id`;
  const hidden = await visibleBets(TEST_SEASON, 1);
  check(
    'hidden while the market still takes bets',
    hidden.some((b) => String(b.id) === String(bet.id)),
    false,
  );
  await lockDueMarkets([HOME, AWAY]);
  const shown = await visibleBets(TEST_SEASON, 1);
  check(
    'shown once the game is over',
    shown.some((b) => String(b.id) === String(bet.id)),
    true,
  );

  console.log('\na prop does not lock until its player kicks off');
  // locks_at is midnight Arizona on the morning of the game. For a Thursday
  // night kickoff that is ~18 hours early, and locking on it alone closed a
  // prop for a game that had not started -- then put the bet on The Floor
  // while everyone else could still see the game coming.
  const prop = await makeMarket({
    live: false,
    locked: true,
    kind: 'prop',
    meta: { playerId: '421', playerName: 'Test QB', nflTeam: 'LAR', rosterId: HOME, line: 17.5 },
  });
  await lockDueMarkets([], new Set(['NE', 'SEA']));
  check('its game has not kicked off', await statusOf(prop), 'open');
  await lockDueMarkets([], new Set(['NE', 'SEA', 'SF', 'LAR']));
  check('its game has kicked off', await statusOf(prop), 'locked');

  console.log('\nan unknown kickoff never closes a prop');
  // This used to fall back to locks_at, which would have reintroduced the exact
  // premature lock the kickoff check exists to prevent -- a Sleeper outage would
  // have shut every Thursday-stamped prop for games days away.
  const prop2 = await makeMarket({
    live: false,
    locked: true,
    kind: 'prop',
    meta: { playerId: '9', playerName: 'Other QB', nflTeam: 'KC', rosterId: HOME, line: 20.5 },
  });
  await lockDueMarkets([], []);
  check('no kickoff data means no lock', await statusOf(prop2), 'open');

  console.log('\na prop with no nflTeam is left alone');
  const noTeam = await makeMarket({
    live: false,
    locked: true,
    kind: 'prop',
    meta: { playerId: '7', playerName: 'No Team', rosterId: HOME, line: 12.5 },
  });
  await lockDueMarkets([], ['NE', 'SEA', 'SF', 'LAR']);
  check('nothing to check kickoff against, so not guessed at', await statusOf(noTeam), 'open');

  console.log('\na league-wide special locks at the first kickoff');
  // It carries no nflTeam, so the prop rule's `= any()` is NULL for it and it
  // would have stayed bettable all season.
  const special = await makeMarket({
    live: false,
    locked: true,
    kind: 'special',
    meta: { special: 'position', position: 'RB' },
  });
  await lockDueMarkets([], []);
  check('nothing kicked off yet', await statusOf(special), 'open');
  await lockDueMarkets([], ['NE', 'SEA']);
  check('the week has started', await statusOf(special), 'locked');

  console.log('\na live market locked on bad data reopens itself');
  // Two markets sat closed all weekend because they were locked during the
  // window when Sleeper wrongly reported unplayed games as started. Nothing
  // would ever have reopened them: a lock was permanent even when the game
  // state it was based on turned out to be wrong.
  const wronglyLocked = await makeMarket({ live: true, locked: true });
  await sql`update markets set status = 'locked' where id = ${wronglyLocked}`;
  check('starts locked', await statusOf(wronglyLocked), 'locked');
  // Neither roster is finished, so the lock is not justified.
  const scope = { season: TEST_SEASON, week: 1 };
  await lockDueMarkets([HOME], [], scope);
  check('reopens when its rosters are not final', await statusOf(wronglyLocked), 'open');

  // And a justified lock must survive the same pass.
  await lockDueMarkets([HOME, AWAY], [], scope);
  check('but a real lock stays locked', await statusOf(wronglyLocked), 'locked');
  await lockDueMarkets([HOME, AWAY], [], scope);
  check('and is not reopened on the next pass', await statusOf(wronglyLocked), 'locked');

  // Without a scope the correction is skipped entirely rather than reaching
  // across every week in the database -- which it did on the first attempt,
  // reopening eight real markets during a test run.
  await sql`update markets set status = 'locked' where id = ${wronglyLocked}`;
  await lockDueMarkets([HOME], []);
  check('no scope means no reopen', await statusOf(wronglyLocked), 'locked');
  await sql`update markets set status = 'open' where id = ${wronglyLocked}`;

  // A prop is a one-way door: reopening it would let someone bet a player who
  // has already scored.
  const shutProp = await makeMarket({
    live: false,
    locked: true,
    kind: 'prop',
    meta: { playerId: '1', playerName: 'Done', nflTeam: 'NE', rosterId: HOME, line: 10.5 },
  });
  await lockDueMarkets([], ['NE']);
  check('a locked prop stays locked', await statusOf(shutProp), 'locked');
  await lockDueMarkets([], []);
  check('even with no kickoff data at all', await statusOf(shutProp), 'locked');

  console.log('\nfinishedRostersIn reads live state');
  check(
    'both sides final',
    finishedRostersIn({
      matchups: {
        '1-2': { homeRoster: 1, awayRoster: 2, home: { final: true }, away: { final: true } },
      },
    }).sort(),
    [1, 2],
  );
  check(
    'one side still playing',
    finishedRostersIn({
      matchups: {
        '1-2': { homeRoster: 1, awayRoster: 2, home: { final: true }, away: { final: false } },
      },
    }),
    [1],
  );
  check('empty state is not an error', finishedRostersIn(null), []);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
