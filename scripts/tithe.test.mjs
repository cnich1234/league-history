/**
 * Cut of the Action: a share of the winnings, not the bet.
 *
 * The gentle end of the shop, and the second attack with a payout. Grand Theft
 * takes everything and leaves the victim nothing; this leaves the bet where it
 * is -- they still win, they still bank -- and pays the attacker a slice.
 *
 * The slice is of the PROFIT, never the payout. Half a payout would claw back
 * part of their stake, so a winning bet could leave them down, which is far
 * more than a 5-point boost should do.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, settleMarket } from '../lib/book.js';
import { BOOSTS, byKind } from '../lib/boosts.js';
import {
  buyBoost,
  useBoostOnBet,
  postBounty,
  contributeToBounty,
  getPoints,
  minimumStake,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9978;
const W = testWeek(S);
const A = 'chris-nicholson';
const B = 'devin-nicholson';
const C = 'brandon-lowe';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` +
    (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
  if (!match) failed++;
};

async function mkt() {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'TITHE ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  await sql`
    insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', 100), (${m.id}, 'away', 'Away', 100)`;
  return Number(m.id);
}
const banked = async (slug) => {
  const [r] = await sql`
    select coalesce(sum(amount_cents),0)::int c from ledger
    where bettor = ${slug} and week is null`;
  return Number(r.c);
};
async function pts(slug, n) {
  await sql`insert into point_ledger (bettor, season, amount, reason, note)
    values (${slug}, ${S}, ${n}, 'adjustment', 'tithe test')`;
}
async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map(r=>r.id);
  const bids = ids.length ? (await sql`select id from bets where market_id = any(${ids})`).map(r=>r.id) : [];
  await sql`delete from bounty_contributions where bounty_id in (select id from bounties where season = ${S})`;
  await sql`delete from bounties where season = ${S}`;
  if (bids.length) {
    await sql`delete from boosts where target_bet_id = any(${bids})`;
    await sql`delete from ledger where bet_id = any(${bids})`;
    await sql`delete from bets where id = any(${bids})`;
  }
  if (ids.length) {
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
  // Seeded from the catalogue -- see attacks2.test.mjs.
  const PURSE = Math.max(...BOOSTS.map((b) => b.cost)) * 8;
  for (const w of [A, B, C]) await pts(w, PURSE);

  console.log('\nhalf the PROFIT, and they keep the bet');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    const t = await buyBoost({ slug: A, season: S, kind: 'tithe' });
    await useBoostOnBet({ slug: A, boostId: Number(t.id), betId: Number(bet.id), season: S });

    const bBefore = await banked(B), aBefore = await banked(A);
    await settleMarket(m, 'home');

    // $100 at +100 -> payout 20000, profit 10000. Half each.
    ok('the attacker takes half the profit', (await banked(A)) - aBefore, 5000);
    ok('and they bank the other half', (await banked(B)) - bBefore, 5000);
    const [row] = await sql`select status from bets where id = ${Number(bet.id)}`;
    ok('the bet is still theirs, and won', row.status, 'won');
  }

  console.log('\nnothing on a loser');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    const t = await buyBoost({ slug: A, season: S, kind: 'tithe' });
    await useBoostOnBet({ slug: A, boostId: Number(t.id), betId: Number(bet.id), season: S });
    const aBefore = await banked(A);
    await settleMarket(m, 'away');
    ok('a gamble like any other', (await banked(A)) - aBefore, 0);
  }

  console.log('\ninsurance blocks it');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    const shield = await buyBoost({ slug: B, season: S, kind: 'insurance' });
    await useBoostOnBet({ slug: B, boostId: Number(shield.id), betId: Number(bet.id) , atPlacement: true });
    const t = await buyBoost({ slug: A, season: S, kind: 'tithe' });
    await useBoostOnBet({ slug: A, boostId: Number(t.id), betId: Number(bet.id), season: S });

    const aBefore = await banked(A), bBefore = await banked(B);
    await settleMarket(m, 'home');
    ok('the attacker gets nothing', (await banked(A)) - aBefore, 0);
    ok('and they keep it all', (await banked(B)) - bBefore, 10000);
  }

  console.log('\na refund is untouched');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    const t = await buyBoost({ slug: A, season: S, kind: 'tithe' });
    await useBoostOnBet({ slug: A, boostId: Number(t.id), betId: Number(bet.id), season: S });
    const aBefore = await banked(A);
    await settleMarket(m, 'push');
    // A push is not a win, so there is no profit to take a slice of.
    ok('no share of a push', (await banked(A)) - aBefore, 0);
  }

  console.log('\ncrowd-funded, the share splits again');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    // Poster puts in the 20% minimum, the backer covers the rest.
    const tCost = byKind['tithe'].cost;
    const tSeed = minimumStake(tCost);
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'tithe',
      betId: Number(bet.id), points: tSeed,
    });
    const res = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: tCost - tSeed,
    });
    ok('it fired', Boolean(res.fired?.fired), true);

    const aBefore = await banked(A), cBefore = await banked(C), bBefore = await banked(B);
    await settleMarket(m, 'home');

    // Profit 10000, half of it is 5000, split by what each put in.
    const half = 5000;
    const pShare = Math.floor((half * tSeed) / tCost);
    const bShare = half - pShare;
    ok('the poster share', (await banked(A)) - aBefore, pShare);
    ok('the backer share', (await banked(C)) - cBefore, bShare);
    ok('and the victim keeps half', (await banked(B)) - bBefore, 5000);
  }
  console.log('\na crowd-funded THEFT splits at settlement too');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 10000 });
    const sCost = byKind['steal'].cost;
    const sSeed = minimumStake(sCost);
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'steal',
      betId: Number(bet.id), points: sSeed,
    });
    const res = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: sCost - sSeed,
    });
    ok('it fired', Boolean(res.fired?.fired), true);

    const aBefore = await banked(A), cBefore = await banked(C), bBefore = await banked(B);
    await settleMarket(m, 'home');

    // The WHOLE payout is stolen -- 20000, not the profit -- split by what
    // each put in. Derived, so a reprice does not turn this into arithmetic
    // nobody can follow: floor each share, remainder to the largest.
    const back = sCost - sSeed;
    const posterShare = Math.floor((20000 * sSeed) / sCost);
    const backerShare = 20000 - posterShare;
    ok('the backer takes the larger share', (await banked(C)) - cBefore, backerShare);
    ok('and the poster the smaller', (await banked(A)) - aBefore, posterShare);
    ok('the victim gets nothing at all', (await banked(B)) - bBefore, 0);
  }

} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
