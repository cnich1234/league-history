/**
 * The read-only guest.
 *
 * "Read-only" is a claim about the SERVER, not the UI. Hiding the bet buttons
 * is a courtesy; what makes it true is that a guest cannot reach a write path
 * even by posting straight at the API.
 *
 * The design decision worth protecting: a guest is NOT a row in `bettors`. A
 * guest with a real slug would flow into placeBet, getMyBets and the bankroll
 * view as though it were a manager -- able to own bets and hold money. Keeping
 * it outside the table means every query that joins on a bettor finds nothing,
 * which is the right answer rather than a special case someone has to remember.
 */
import { neon } from '@neondatabase/serverless';
// identity.js, not auth.js: auth.js imports next/headers for cookie access,
// which does not resolve outside a Next request.
import { GUEST_SLUG, isGuestSlug, makeToken, verifyToken } from '../lib/identity.js';
import { placeBet, placeParlay, getMyBets, getBankrolls } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);
const TEST_SEASON = 9994;

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
const rejects = async (label, fn) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a rejection)`);
    failed++;
  } catch {
    console.log(`  ok   ${label}`);
  }
};

async function makeMarket() {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, meta)
    values (${TEST_SEASON}, 1, 'h2h', ${'GUEST TEST ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', '{}'::jsonb)
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
  // Belt and braces: nothing should ever exist under the guest slug.
  await sql`delete from ledger where bettor = ${GUEST_SLUG}`;
  await sql`delete from bets where bettor = ${GUEST_SLUG}`;
}

await cleanup();

try {
  console.log('\nthe guest is not a manager');
  const bettors = await sql`select slug from bettors`;
  check(
    'no bettor row uses the reserved slug',
    bettors.some((b) => b.slug === GUEST_SLUG),
    false,
  );
  check('and the slug is recognised as a guest', isGuestSlug(GUEST_SLUG), true);
  check('a real slug is not', isGuestSlug('chris-nicholson'), false);
  check('nor is null', isGuestSlug(null), false);

  console.log('\nthe session is a real signed session');
  // It must not be forgeable just because there is no password behind it.
  const token = makeToken(GUEST_SLUG);
  check('round-trips', verifyToken(token), GUEST_SLUG);
  check('a tampered token is refused', verifyToken(`${GUEST_SLUG}.deadbeef`), null);
  check('an unsigned slug is refused', verifyToken(GUEST_SLUG), null);

  console.log('\nwrites are refused at the data layer');
  // Not merely hidden in the UI: these are the calls the API routes make, and
  // they must fail even when reached directly.
  const market = await makeMarket();
  await rejects('cannot place a straight bet', () =>
    placeBet({ slug: GUEST_SLUG, marketId: market, optionKey: 'home', stakeCents: 2500 }),
  );
  const m2 = await makeMarket();
  await rejects('cannot place a parlay', () =>
    placeParlay({
      slug: GUEST_SLUG,
      stakeCents: 2500,
      legs: [
        { marketId: market, optionKey: 'home' },
        { marketId: m2, optionKey: 'home' },
      ],
    }),
  );

  console.log('\nand nothing was written anyway');
  const [{ n: betCount }] = await sql`
    select count(*)::int as n from bets where bettor = ${GUEST_SLUG}`;
  check('no bets under the guest slug', betCount, 0);
  const [{ n: ledgerCount }] = await sql`
    select count(*)::int as n from ledger where bettor = ${GUEST_SLUG}`;
  check('no ledger rows either', ledgerCount, 0);

  console.log('\nreads return nothing rather than failing');
  check('the guest has no bets', await getMyBets(GUEST_SLUG), []);
  const banks = await getBankrolls();
  check(
    'and no bankroll',
    banks.some((b) => b.slug === GUEST_SLUG),
    false,
  );
  check('while real bankrolls still load', banks.length > 0, true);

  console.log('\nledger integrity');
  const mismatched = await sql`
    select b.slug from bankrolls b
    join (select bettor, coalesce(sum(amount_cents), 0) as total from ledger group by bettor) l
      on l.bettor = b.slug
    where b.balance_cents <> l.total`;
  check('every balance still equals its ledger', mismatched.map((r) => r.slug), []);
} finally {
  await cleanup();
}

console.log('\ncleanup');
const [{ n }] = await sql`select count(*)::int as n from markets where season = ${TEST_SEASON}`;
check('test data removed', n, 0);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
