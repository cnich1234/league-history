/**
 * End-to-end test of the betting rules against the real database.
 *
 * Creates scratch markets in a sentinel season, attacks every rule that
 * protects the game, then cleans up in a `finally` so a failing assertion can
 * never leave a real bankroll wrong. Rules that live only in the UI are not
 * rules, so each is tested through the data layer directly.
 */
import { neon } from '@neondatabase/serverless';
import { placeBet, settleMarket, visibleBets, getBankrolls, getMyBets } from '../lib/book.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9999;

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
const rejects = async (label, fn, fragment) => {
  try {
    await fn();
    console.log(`  FAIL ${label}\n         expected a rejection`);
    failed++;
  } catch (e) {
    if (!fragment || e.message.toLowerCase().includes(fragment.toLowerCase())) {
      console.log(`  ok   ${label}`);
    } else {
      console.log(`  FAIL ${label}\n         wrong error: ${e.message}`);
      failed++;
    }
  }
};

const A = 'chris-nicholson';
const B = 'chad-rissland';
const balanceOf = async (slug) =>
  Number((await getBankrolls()).find((r) => r.slug === slug).balance_cents);

async function makeMarket({ locked = false } = {}) {
  const locksAt = locked ? new Date(Date.now() - 3600e3) : new Date(Date.now() + 86400e3);
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, meta)
    values (${TEST_SEASON}, 1, 'h2h', ${'TEST ' + Math.random()}, ${locksAt}, ${locked ? 'locked' : 'open'}, '{"test":true}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', -150), (${m.id}, 'away', 'Away', 130)`;
  return Number(m.id);
}

/** Removes everything the sentinel season touched, plus the throwaway bettor. */
async function cleanup() {
  const ids = (await sql`select id from markets where season = ${TEST_SEASON}`).map((r) => r.id);
  if (ids.length) {
    await sql`delete from ledger where bet_id in (select id from bets where market_id = any(${ids}))`;
    await sql`delete from bets where market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await sql`delete from ledger where bettor = 'test-broke'`;
  await sql`delete from bettors where slug = 'test-broke'`;
}

try {
  console.log('\nplacing bets');
  const m1 = await makeMarket();
  const before = await balanceOf(A);
  const bet = await placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 5000 });
  check('bet is recorded', Number(bet.stake_cents), 5000);
  check('odds frozen at placement', bet.odds, -150);
  check('stake is debited immediately', before - (await balanceOf(A)), 5000);

  console.log('\nrules');
  await rejects(
    'cannot bet twice on one market',
    () => placeBet({ slug: A, marketId: m1, optionKey: 'away', stakeCents: 5000 }),
    'already have a bet',
  );
  await rejects(
    'cannot bet under the minimum',
    () => placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 500 }),
    'minimum',
  );
  await rejects(
    'cannot bet over the maximum',
    () => placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 30000 }),
    'maximum',
  );
  await rejects(
    'cannot bet a fractional cent',
    () => placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 1000.5 }),
    'whole number',
  );
  await rejects(
    'cannot bet a nonexistent option',
    () => placeBet({ slug: B, marketId: m1, optionKey: 'nope', stakeCents: 5000 }),
    'no such option',
  );

  // A throwaway bettor with $15 cannot cover $250. Draining a real manager's
  // bankroll here would corrupt every later assertion.
  await sql`insert into bettors (slug, display_name) values ('test-broke', 'Broke')
            on conflict (slug) do nothing`;
  await sql`delete from ledger where bettor = 'test-broke'`;
  await sql`insert into ledger (bettor, amount_cents, reason, note)
            values ('test-broke', 1500, 'seed', 'test')`;
  await rejects(
    'cannot bet more than the bankroll',
    () => placeBet({ slug: 'test-broke', marketId: m1, optionKey: 'home', stakeCents: 25000 }),
    'not enough',
  );

  const mLocked = await makeMarket({ locked: true });
  await rejects(
    'cannot bet a locked market',
    () => placeBet({ slug: A, marketId: mLocked, optionKey: 'home', stakeCents: 5000 }),
    'closed',
  );

  console.log('\nhidden until lock');
  const m2 = await makeMarket();
  await placeBet({ slug: B, marketId: m2, optionKey: 'away', stakeCents: 2000 });
  const hidden = await visibleBets(TEST_SEASON, 1);
  check(
    'unlocked bets are invisible to everyone',
    hidden.filter((b) => [m1, m2].includes(Number(b.market_id))).length,
    0,
  );
  check(
    'but the owner always sees their own',
    (await getMyBets(B)).some((b) => Number(b.market_id) === m2),
    true,
  );

  // Locking is a status change, not a past timestamp. A prop's locks_at is
  // midnight on the morning of the game, so treating that as "closed" published
  // bets on games that had not started.
  await sql`update markets set status = 'locked' where id = ${m2}`;
  // Read back through the same path the app uses, after the write has landed.
  const shown = await visibleBets(TEST_SEASON, 1);
  check(
    'locked bets become public',
    shown.some((b) => Number(b.market_id) === m2),
    true,
  );

  console.log('\nsettlement');
  const winBefore = await balanceOf(A);
  const result = await settleMarket(m1, 'home');
  check('one bet settled', result.settled, 1);
  check('payout matches the odds', result.paidCents, payoutCents(5000, -150));
  check(
    'winner credited stake plus profit',
    (await balanceOf(A)) - winBefore,
    payoutCents(5000, -150),
  );
  await rejects('cannot settle twice', () => settleMarket(m1, 'home'), 'already settled');

  const m3 = await makeMarket();
  await placeBet({ slug: A, marketId: m3, optionKey: 'away', stakeCents: 3000 });
  const lossBefore = await balanceOf(A);
  await settleMarket(m3, 'home');
  check('loser gets nothing back', await balanceOf(A), lossBefore);

  const m4 = await makeMarket();
  await placeBet({ slug: A, marketId: m4, optionKey: 'home', stakeCents: 4000 });
  const pushBefore = await balanceOf(A);
  await settleMarket(m4, 'push');
  check('push refunds the stake', (await balanceOf(A)) - pushBefore, 4000);

  console.log('\nledger integrity');
  const [{ sum }] = await sql`
    select coalesce(sum(amount_cents), 0)::bigint as sum from ledger where bettor = ${A}`;
  const [bank] = await sql`select balance_cents from bankrolls where slug = ${A}`;
  check('balance always equals the ledger sum', Number(bank.balance_cents), Number(sum));
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);
// Real bets exist now, so bankrolls are legitimately not $1000 any more. What
// still has to hold is that every balance is explained by its own ledger --
// the invariant that would actually catch a settlement or payout bug.
const mismatched = await sql`
  select b.slug from bankrolls b
  join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
    on l.bettor = b.slug
  where b.balance_cents <> l.total
  order by b.slug`;
check(
  'every balance equals its ledger',
  mismatched.map((r) => r.slug),
  [],
);
const [{ leftover }] = await sql`
  select count(*)::int as leftover from bettors where slug = 'test-broke'`;
check('no test bettor left behind', leftover, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
