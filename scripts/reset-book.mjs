/**
 * Wipes betting activity back to opening bankrolls.
 *
 * For when a settlement goes wrong and untangling it is more work than starting
 * the week over. Deliberately requires --confirm: this destroys real bets, and
 * a typo that runs it mid-season should not silently succeed.
 *
 * Scopes, narrowest first:
 *   --week <n>   remove bets and markets for one week only
 *   --bets       remove every bet, keep the markets
 *   --all        remove everything and re-seed bankrolls at $1,000
 *
 * Accounts and passwords are never touched -- nobody should have to sign up
 * again because a week settled badly.
 */
import { neon } from '@neondatabase/serverless';

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
if (scope === 'all') console.log('  bankrolls will be re-seeded at $1,000');

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
  await sql`delete from parlay_legs where bet_id = any(${betIds})`;
  await sql`delete from ledger where bet_id = any(${betIds})`;
  await sql`delete from bets where id = any(${betIds})`;
}

if (scope !== 'bets' && marketIds.length) {
  await sql`delete from market_options where market_id = any(${marketIds})`;
  await sql`delete from markets where id = any(${marketIds})`;
}

if (scope === 'all') {
  // Re-seed from scratch: one seed row each, nothing else.
  await sql`delete from ledger`;
  await sql`delete from buyins where season = ${SEASON}`;
  for (const b of await sql`select slug from bettors`) {
    await sql`
      insert into ledger (bettor, amount_cents, reason, note)
      values (${b.slug}, 100000, 'seed', 'Opening bankroll')`;
  }
}

console.log('\nDone. Bankrolls:');
for (const r of await sql`select slug, balance_cents from bankrolls order by slug`) {
  console.log(`  ${r.slug.padEnd(20)} $${(Number(r.balance_cents) / 100).toFixed(2)}`);
}
