/**
 * The week roll against the database, in a sentinel season nobody plays.
 * Feeds are injected so Sleeper is never called; the test is the arithmetic
 * landing in market_baselines and being read back as premiums.
 */
import { neon } from '@neondatabase/serverless';
import { rollWeek, ensureRolled, premiums, forgetPremiums } from '../lib/market/baselines.js';

const SEASON = 9985;
const sql = neon(process.env.DATABASE_URL);

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` + (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
  if (!match) failed++;
};

await sql`delete from market_baselines where season = ${SEASON}`;
forgetPremiums();

console.log('\nweek 1 carries nothing');
ok('no premiums before a roll', (await premiums(SEASON, 1)).size, 0);
ok('nothing to roll into week 1', await ensureRolled(SEASON, 1), { skipped: 'first week' });

console.log('\nrolling week 1 into week 2');
{
  const r = await rollWeek({
    season: SEASON,
    fromWeek: 1,
    toWeek: 2,
    projFrom: { boom: 20, bust: 20, flat: 10, bye: 0, nobody: 0 },
    actualFrom: { boom: 30, bust: 10, flat: 10, bye: 0, nobody: 0 },
    premiumFrom: new Map(),
  });
  ok('three players written, the bye and the nobody skipped', r.rolled, 3);
  const p = await premiums(SEASON, 2);
  ok('the boom carries 3.75', p.get('boom').premium, 3.75);
  ok('the bust carries -3.75', p.get('bust').premium, -3.75);
  ok('flat carries nothing', p.get('flat').premium, 0);
  ok('the dividend is recorded', p.get('boom').dividend, 1.5);
  ok('and what it was for', [p.get('boom').prevActual, p.get('boom').prevProjection], [30, 20]);
}

console.log('\nrolling again is a no-op');
{
  const again = await ensureRolled(SEASON, 2);
  ok('already rolled', again.already, 3);
  const r = await rollWeek({
    season: SEASON, fromWeek: 1, toWeek: 2,
    projFrom: { boom: 20 }, actualFrom: { boom: 99 }, premiumFrom: new Map(),
  });
  forgetPremiums();
  ok('a second roll writes nothing new', (await premiums(SEASON, 2)).get('boom').premium, 3.75);
  ok('even though it tried', r.rolled, 1);
}

console.log('\nweek 2 into week 3 decays the old premium');
{
  await rollWeek({
    season: SEASON,
    fromWeek: 2,
    toWeek: 3,
    projFrom: { boom: 20, bust: 20, flat: 10 },
    actualFrom: { boom: 20, bust: 20, flat: 0 },
  });
  forgetPremiums();
  const p = await premiums(SEASON, 3);
  ok('the boom fades to 2.81', p.get('boom').premium, 2.81);
  ok('the bust fades to -2.81', p.get('bust').premium, -2.81);
  ok('a dud week on flat is a new bust', p.get('flat').premium, -3.75);
}

await sql`delete from market_baselines where season = ${SEASON}`;
console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
