/**
 * The board banner: what is bending the market, and what is nobody's business.
 *
 * The line this draws is the whole point. A boost belongs on the banner when it
 * changes what a market is worth to EVERYONE looking at it, or when it alters a
 * whole week's settlement. It does not belong there when its value depends on
 * the victim not knowing -- naming a blind attack would hand the attacker's
 * points back as information.
 *
 * So these tests are mostly about what does NOT appear.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet } from '../lib/book.js';
import {
  buyBoost,
  useBoostOnBet,
  useBoostOnWeek,
  curseWeek,
  slowPlay,
  marketEffects,
} from '../lib/shop.js';
import { BOOSTS, byKind } from '../lib/boosts.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9981;
const W = testWeek(S);
const A = 'chris-nicholson';
const B = 'devin-nicholson';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

async function mkt(title) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${title},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', 200), (${m.id}, 'away', 'Away', 200)`;
  return Number(m.id);
}

async function pts(slug, n) {
  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${slug}, ${S}, ${n}, 'adjustment', 'effects test')`;
}

async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => r.id);
  const bids = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  if (bids.length) {
    await sql`delete from boosts where target_bet_id = any(${bids})`;
    await sql`delete from ledger where bet_id = any(${bids})`;
    await sql`delete from bets where id = any(${bids})`;
  }
  if (ids.length) {
    await sql`delete from boosts where target_market_id = any(${ids})`;
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await sql`delete from boosts where season = ${S}`;
  await sql`delete from point_ledger where season = ${S}`;
  await unfundWeek(W);
}

await clean();
await fundWeek(W);

try {
  await pts(A, 400);
  await pts(B, 400);

  console.log('\nnothing to report on a clean week');
  {
    const e = await marketEffects(S, W);
    ok('no markets', e.markets, []);
    ok('no week effects', e.weekly, []);
  }

  console.log('\npoison shows up, because it charges everyone');
  const poisoned = await mkt('EFF Poisoned Market');
  {
    const p = await buyBoost({ slug: A, season: S, kind: 'market-poison' });
    await sql`
      update boosts set target_market_id = ${poisoned}, used_at = now()
      where id = ${Number(p.id)}`;

    const e = await marketEffects(S, W);
    ok('one market listed', e.markets.length, 1);
    ok('named', e.markets[0].title, 'EFF Poisoned Market');
    ok('with the culprit', e.markets[0].by, 'Chris');
    // The banner quotes the number, so it has to come from the catalogue
    // rather than being retyped in the component.
    ok('and the size of the bump', e.markets[0].bump > 0, true);
  }

  console.log('\nbut not before it is used');
  {
    const unused = await buyBoost({ slug: B, season: S, kind: 'market-poison' });
    const other = await mkt('EFF Untouched');
    await sql`update boosts set target_market_id = ${other} where id = ${Number(unused.id)}`;
    const e = await marketEffects(S, W);
    ok('an unused poison is not announced', e.markets.length, 1);
  }

  console.log('\nweek-wide multipliers are public');
  {
    const big = await buyBoost({ slug: A, season: S, kind: 'boost-week' });
    await useBoostOnWeek({ slug: A, boostId: Number(big.id), week: W });
    const curse = await buyBoost({ slug: B, season: S, kind: 'week-curse' });
    await curseWeek({ slug: B, boostId: Number(curse.id), target: A, week: W });

    const e = await marketEffects(S, W);
    ok('both listed', e.weekly.length, 2);
    const bw = e.weekly.find((x) => x.kind === 'boost-week');
    const wc = e.weekly.find((x) => x.kind === 'week-curse');
    // A self-boost names its owner; a curse names its VICTIM, which is the
    // person everyone actually wants to know about.
    ok('big week names the buyer', bw.who, 'Chris');
    ok('the curse names the victim', wc.who, 'Chris');
    ok('and who threw it', wc.by, 'Devin');
  }

  console.log('\na slow play is in play too');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });
    const e = await marketEffects(S, W);
    const sp = e.weekly.find((x) => x.kind === 'slow-play');
    // It was left out of the query entirely -- week-scoped, aimed at a person,
    // and the victim already gets told, so it belongs on the banner.
    ok('it is listed', Boolean(sp), true);
    ok('and names the victim', sp?.who, 'Devin');
    ok('and who threw it', sp?.by, 'Chris');
    ok('with the stake floor', sp?.minStake, byKind['slow-play'].minStakeDollars);
  }

  console.log('\nblind attacks stay blind');
  {
    const before = await marketEffects(S, W);
    // One attack per BET now, so these go on three different bets. The point
    // is unchanged: three attacks landed this week and the banner says nothing.
    for (const kind of ['payout-cut', 'void', 'blind-sabotage']) {
      const m = await mkt('EFF Secret ' + kind);
      const bet = await placeBet({ slug: A, marketId: m, optionKey: 'home', stakeCents: 5000 });
      const bst = await buyBoost({ slug: B, season: S, kind });
      await useBoostOnBet({
        slug: B,
        boostId: Number(bst.id),
        betId: Number(bet.id),
        season: S,
      });
    }
    const after = await marketEffects(S, W);
    // Measured against what the banner said BEFORE, rather than a fixed count
    // that goes stale every time a week-scoped boost is added.
    ok('no bet-level attack leaks', after.markets.length, before.markets.length);
    ok('and the week list is unchanged', after.weekly.length, before.weekly.length);
  }

  console.log('\nanother week is not this week');
  {
    const e = await marketEffects(S, W + 1);
    ok('nothing bleeds across', [e.markets.length, e.weekly.length], [0, 0]);
  }
} finally {
  await clean();
}

console.log('\nevery week-scoped effect reaches the banner');
{
  // Slow Play was week-scoped, public, and simply missing from the query --
  // nothing caught it because nothing checked the SET. This fails the moment
  // another week- or person-scoped boost is added and not wired up.
  const ANNOUNCED = ['boost-week', 'week-curse', 'slow-play'];
  const weekScoped = BOOSTS.filter((b) => b.target === 'week' || b.target === 'bettor')
    .map((b) => b.kind)
    // Ghost hides bets rather than changing what anything is worth, and
    // announcing it would defeat the boost.
    .filter((k) => k !== 'ghost')
    .sort();
  ok('the banner covers them all', ANNOUNCED.slice().sort(), weekScoped);
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
