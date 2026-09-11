import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

/**
 * A week number reserved for one test suite.
 *
 * Suites isolate by sentinel SEASON (9992-9999) but every one of them used
 * week 1 -- which under the weekly allowance is a real week with real money in
 * it. Funding "week 1" in a test would have put test money where live bets are
 * spent from. Deriving the week from the season keeps each suite in its own
 * pot, far outside any week the NFL will ever have.
 */
export const testWeek = (season) => 900 + (season % 100);

/**
 * Funds a suite's week so bets can be placed in it.
 *
 * Every suite that places a bet needs this now. Under the old season-bankroll
 * model a bettor simply had money; under the weekly allowance they have money
 * *in a week*, and a week nobody has opened has nothing in it. Five suites
 * started failing with "Not enough left this week" the moment the model
 * changed, which is the model working rather than a bug.
 *
 * Written as an 'adjustment' rather than an 'allowance': the allowance carries
 * a once-per-week unique index, so a suite funding the same week twice would
 * silently get nothing the second time.
 */
export async function fundWeek(week, cents = 1000000) {
  const bettors = await sql`select slug from bettors`;
  for (const b of bettors) {
    await sql`
      insert into ledger (bettor, amount_cents, reason, note, week)
      values (${b.slug}, ${cents}, 'adjustment', 'test funding', ${week})`;
  }
}

/** Removes a suite's funding. Call from cleanup, beside the market teardown. */
export async function unfundWeek(week) {
  await sql`delete from ledger where week = ${week} and note = 'test funding'`;
}
