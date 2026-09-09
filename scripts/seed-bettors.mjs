/**
 * Creates the ten bettors and their opening $1,000.
 *
 * The seed is a ledger row like any other, not a special column, so a bankroll
 * is always the sum of its ledger and never a number someone set by hand.
 * Re-running is safe: the seed is skipped for anyone who already has one.
 */
import { neon } from '@neondatabase/serverless';
import { SLEEPER_OWNERS } from './sleeper-owners.mjs';

const sql = neon(process.env.DATABASE_URL);
const OPENING_CENTS = 100_000; // $1,000

for (const { slug, name } of Object.values(SLEEPER_OWNERS)) {
  await sql`
    insert into bettors (slug, display_name) values (${slug}, ${name})
    on conflict (slug) do update set display_name = excluded.display_name`;

  const [existing] = await sql`
    select 1 from ledger where bettor = ${slug} and reason = 'seed' limit 1`;
  if (existing) {
    console.log(`  skip  ${slug} (already seeded)`);
    continue;
  }
  await sql`
    insert into ledger (bettor, amount_cents, reason, note)
    values (${slug}, ${OPENING_CENTS}, 'seed', 'Opening bankroll')`;
  console.log(`  seed  ${slug} $${(OPENING_CENTS / 100).toFixed(2)}`);
}

console.log('\nBankrolls:');
for (const r of await sql`select slug, balance_cents from bankrolls order by slug`) {
  console.log(`  ${r.slug.padEnd(20)} $${(Number(r.balance_cents) / 100).toFixed(2)}`);
}
