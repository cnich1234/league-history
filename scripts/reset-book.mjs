/**
 * Wipes betting activity back to a clean opening state.
 *
 * For when a settlement goes wrong and untangling it is more work than starting
 * over, and for the reset before the league goes live. Deliberately requires
 * --confirm: this destroys real bets, and a typo that runs it mid-season should
 * not silently succeed.
 *
 * Scopes, narrowest first:
 *   --week <n>   bets and markets for one week only
 *   --bets       every bet, keeping the markets
 *   --all        everything: bets, markets, money, points, boosts, bounties,
 *                and the weekly scoring -- then re-seeds the opening balances
 *
 * Accounts and passwords are never touched. Nobody should have to sign up again
 * because a week settled badly.
 *
 * This used to re-seed a $1,000 season bankroll, which stopped existing when
 * the league moved to a weekly allowance, and it knew nothing about points,
 * boosts or bounties -- so --all left a "clean" book still carrying everybody's
 * shop inventory and half-funded bounties.
 */
import { neon } from '@neondatabase/serverless';
import { WEEKLY_ALLOWANCE } from '../lib/boosts.js';

/*
 * A NOTE ON REHEARSING THIS SCRIPT.
 *
 * The @neondatabase/serverless HTTP driver does not hold a transaction across
 * separate sql.query() calls -- each one is its own round trip and commits on
 * its own. `begin` ... `rollback` around a sequence of deletes therefore does
 * NOTHING, and every delete is permanent. I wiped this book that way while
 * trying to prove the delete ORDER was safe.
 *
 * To rehearse destructive SQL, use a scratch schema or a Neon branch. Do not
 * reach for a transaction here expecting it to save you.
 */

const sql = neon(process.env.DATABASE_URL);
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const weekFlag = args.indexOf('--week');
const week = weekFlag > -1 ? Number(args[weekFlag + 1]) : null;
const scope = args.includes('--all') ? 'all' : args.includes('--bets') ? 'bets' : week ? 'week' : null;

if (!scope) {
  console.error(`Usage:
  node --env-file=.env.local scripts/reset-book.mjs --week 2 --confirm
  node --env-file=.env.local scripts/reset-book.mjs --bets --confirm
  node --env-file=.env.local scripts/reset-book.mjs --all --confirm`);
  process.exit(1);
}

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Shop points every manager starts the season with.
 *
 * Six weeks of allowance in the hand on day one. Enough to buy something that
 * bites in week one rather than spending the first month saving -- the shop is
 * most of what makes the board interesting, and an empty shop in September is a
 * quiet start.
 */
const OPENING_POINTS = 30;

// Show what would go before anything is deleted, so --confirm is an informed
// choice rather than a formality.
const marketIds =
  scope === 'week'
    ? (await sql`select id from markets where season = ${SEASON} and week = ${week}`).map((r) => r.id)
    : (await sql`select id from markets where season = ${SEASON}`).map((r) => r.id);

const [{ betCount }] = marketIds.length
  ? await sql`
      select count(*)::int as "betCount" from bets
      where market_id = any(${marketIds})
         or id in (select bet_id from parlay_legs where market_id = any(${marketIds}))`
  : [{ betCount: 0 }];

console.log(`Scope: ${scope}${scope === 'week' ? ` (week ${week})` : ''}`);
console.log(`  markets: ${marketIds.length}`);
console.log(`  bets:    ${betCount}`);

if (scope === 'all') {
  const [counts] = await sql`
    select (select count(*)::int from point_ledger) as points,
           (select count(*)::int from boosts) as boosts,
           (select count(*)::int from bounties) as bounties,
           (select count(*)::int from weekly_awards) as awards,
           (select count(*)::int from weekly_scores) as scores,
           (select count(*)::int from ledger) as money`;
  console.log(`  points:    ${counts.points} ledger rows`);
  console.log(`  boosts:    ${counts.boosts}`);
  console.log(`  bounties:  ${counts.bounties}`);
  console.log(`  scoring:   ${counts.awards} award(s), ${counts.scores} week(s)`);
  console.log(`  money:     ${counts.money} ledger rows`);
  console.log(`\n  everyone will be re-seeded at ${OPENING_POINTS} points and no money`);
  console.log(`  (the cron pays the first weekly allowance)`);
}

if (!confirm) {
  console.log('\nNothing changed. Add --confirm to actually do it.');
  process.exit(0);
}

const betIds = marketIds.length
  ? (
      await sql`
        select id from bets
        where market_id = any(${marketIds})
           or id in (select bet_id from parlay_legs where market_id = any(${marketIds}))`
    ).map((r) => r.id)
  : [];

if (betIds.length) {
  // Boosts reference bets, and bounties reference boosts, so they unwind in
  // that order or the foreign keys refuse.
  await sql`delete from parlay_legs where bet_id = any(${betIds})`;
  await sql`update bounties set claim_boost_id = null where claim_boost_id is not null`;
  await sql`delete from boosts where target_bet_id = any(${betIds})`;
  await sql`delete from ledger where bet_id = any(${betIds})`;
  await sql`delete from bets where id = any(${betIds})`;
}

if (scope !== 'bets' && marketIds.length) {
  await sql`delete from boosts where target_market_id = any(${marketIds})`;
  await sql`delete from live_quotes where market_id = any(${marketIds})`;
  await sql`delete from market_options where market_id = any(${marketIds})`;
  await sql`delete from markets where id = any(${marketIds})`;
}

if (scope === 'all') {
  // Everything downstream of a bet, in dependency order.
  await sql`delete from bounty_contributions`;
  await sql`delete from bounties`;
  await sql`delete from boosts`;
  await sql`delete from ledger`;
  await sql`delete from point_ledger`;
  await sql`delete from weekly_awards`;
  await sql`delete from weekly_scores`;
  await sql`delete from buyins where season = ${SEASON}`;

  // Opening points. No money seed: the weekly allowance is granted by the
  // cron, and handing out a lump sum here would be a second, competing idea
  // of what a bankroll is -- which is the bug this script used to have.
  for (const b of await sql`select slug from bettors`) {
    await sql`
      insert into point_ledger (bettor, season, amount, reason, note)
      values (${b.slug}, ${SEASON}, ${OPENING_POINTS}, 'adjustment', 'Opening balance')`;
  }
}

console.log('\nDone.');
if (scope === 'all') {
  console.log(`\nPoints (${WEEKLY_ALLOWANCE}/week from the cron on top):`);
  for (const r of await sql`
    select b.slug, coalesce(sum(p.amount), 0)::int as points
    from bettors b
    left join point_ledger p on p.bettor = b.slug and p.season = ${SEASON}
    group by b.slug order by b.slug`) {
    console.log(`  ${r.slug.padEnd(20)} ${r.points}`);
  }
} else {
  console.log('\nBankrolls:');
  for (const r of await sql`select slug, balance_cents from bankrolls order by slug`) {
    console.log(`  ${r.slug.padEnd(20)} $${(Number(r.balance_cents) / 100).toFixed(2)}`);
  }
}
