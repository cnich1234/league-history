/**
 * Field markets take one straight bet per option.
 *
 * The weekly specials -- highest scoring team, RB, WR, TE -- are ONE market
 * with a manager per option. One-bet-per-market was written when every market
 * had two sides, where a second bet could only be more money on a side you
 * already held. On a ten-horse field it blocked something else entirely:
 * backing a different manager, an outcome that cannot win alongside the first.
 *
 * What must hold:
 *   Several straight bets on ONE field market, one per manager.
 *   The same manager twice is still refused (that IS stacking a side).
 *   A two-sided market still takes exactly one bet, Hedge aside.
 *   Every one of them settles: the winner pays, the losers do not.
 *
 * Sentinel season, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, placeParlay, settleMarket } from '../lib/book.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9978;
const W = testWeek(S);
const A = 'chris-nicholson';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};
const rejects = async (label, fn, needle) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a refusal, got none)`);
    failed++;
  } catch (err) {
    const hit = !needle || err.message.toLowerCase().includes(needle.toLowerCase());
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${label}${hit ? '' : ` (got "${err.message}")`}`);
    if (!hit) failed++;
  }
};

/** A market of `kind` with one option per manager. */
async function mkt(kind, options) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, ${kind}, ${'FT ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  for (const [k, l, o] of options) {
    await sql`insert into market_options (market_id, option_key, label, odds)
              values (${m.id}, ${k}, ${l}, ${o})`;
  }
  return Number(m.id);
}

const FIELD = [
  ['1', 'Token Effort', 792],
  ['2', 'Seal Team Nix', 931],
  ['3', 'Gronkey Punch', 664],
  ['4', 'JSN Derulo', 852],
];

try {
  await fundWeek(W);

  console.log('\nseveral managers in one field market');
  {
    const m = await mkt('special', FIELD);
    const a = await placeBet({ slug: A, marketId: m, optionKey: '1', stakeCents: 1000 });
    ok('first manager backed', Boolean(a?.id), true);
    const b = await placeBet({ slug: A, marketId: m, optionKey: '2', stakeCents: 1000 });
    ok('a second manager is allowed', Boolean(b?.id), true);
    const c = await placeBet({ slug: A, marketId: m, optionKey: '3', stakeCents: 1000 });
    ok('and a third', Boolean(c?.id), true);

    const [{ n }] = await sql`
      select count(*)::int n from bets
      where bettor = ${A} and market_id = ${m} and status <> 'void'`;
    ok('three straight bets on one market', n, 3);

    // This is the rule that was always the point: more money on a side you
    // already hold, which would dodge any per-bet limit.
    await rejects(
      'the SAME manager twice is still refused',
      () => placeBet({ slug: A, marketId: m, optionKey: '1', stakeCents: 1000 }),
      'already',
    );
  }

  console.log('\na two-sided market is unchanged');
  {
    const m = await mkt('h2h', [
      ['home', 'Home', 100],
      ['away', 'Away', -120],
    ]);
    await placeBet({ slug: A, marketId: m, optionKey: 'home', stakeCents: 1000 });
    await rejects(
      'still one bet per market without a Hedge',
      () => placeBet({ slug: A, marketId: m, optionKey: 'away', stakeCents: 1000 }),
      'already have a bet',
    );
  }

  console.log('\nthe held managers still reach a parlay');
  {
    const m = await mkt('special', FIELD);
    const other = await mkt('h2h', [
      ['home', 'Home', 100],
      ['away', 'Away', -120],
    ]);
    await placeBet({ slug: A, marketId: m, optionKey: '1', stakeCents: 1000 });
    const p = await placeParlay({
      slug: A,
      stakeCents: 1000,
      legs: [
        { marketId: m, optionKey: '2' },
        { marketId: other, optionKey: 'home' },
      ],
    });
    ok('a different manager rides in a parlay', Boolean(p?.id), true);

    await rejects(
      'two managers from one market cannot share a parlay',
      () =>
        placeParlay({
          slug: A,
          stakeCents: 1000,
          legs: [
            { marketId: m, optionKey: '1' },
            { marketId: m, optionKey: '2' },
          ],
        }),
      'different market',
    );
  }

  console.log('\nall of them settle');
  {
    const m = await mkt('special', FIELD);
    await placeBet({ slug: A, marketId: m, optionKey: '1', stakeCents: 1000 });
    await placeBet({ slug: A, marketId: m, optionKey: '2', stakeCents: 1000 });
    await placeBet({ slug: A, marketId: m, optionKey: '3', stakeCents: 1000 });
    await settleMarket(m, '2');

    const rows = await sql`
      select option_key, status from bets
      where bettor = ${A} and market_id = ${m} order by option_key`;
    ok(
      'the backed manager wins, the rest lose',
      rows.map((r) => `${r.option_key}:${r.status}`),
      ['1:lost', '2:won', '3:lost'],
    );
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall good');
} finally {
  // `bets` has no season column, so the teardown is scoped through the
  // markets. A parlay has a null market_id and is reachable only through its
  // legs, so it is collected first and deleted by id.
  const parlayIds = (
    await sql`select distinct bet_id from parlay_legs
              where market_id in (select id from markets where season = ${S})`
  ).map((r) => Number(r.bet_id));
  const straightIds = (
    await sql`select id from bets
              where market_id in (select id from markets where season = ${S})`
  ).map((r) => Number(r.id));
  const betIds = [...new Set([...parlayIds, ...straightIds])];

  if (betIds.length) {
    await sql`delete from parlay_legs where bet_id = any(${betIds})`;
    await sql`delete from ledger where bet_id = any(${betIds})`;
    await sql`delete from bets where id = any(${betIds})`;
  }
  await sql`delete from market_options where market_id in (select id from markets where season = ${S})`;
  await sql`delete from markets where season = ${S}`;
  await unfundWeek(W);
}

process.exit(failed ? 1 : 0);
