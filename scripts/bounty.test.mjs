/**
 * Bounties: paying somebody else to do your dirty work.
 *
 * The only thing in the app where one manager's move is worth money to another.
 * Three rules carry it:
 *
 *   The weapon is NAMED. Hitting the right person the wrong way earns nothing,
 *   which is what makes choosing a weapon a real constraint.
 *
 *   The reward is ESCROWED at posting. Otherwise someone could advertise ten
 *   points, watch a claim land, and have nothing to pay with.
 *
 *   Unclaimed bounties REFUND. Nobody did the thing that was asked for, so the
 *   points go home rather than being forfeit.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet } from '../lib/book.js';
import {
  buyBoost,
  useBoostOnBet,
  postBounty,
  openBounties,
  expireBounties,
  getPoints,
  slowPlay,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9982;
const W = testWeek(S);
const A = 'chris-nicholson'; // poster
const B = 'devin-nicholson'; // target
const C = 'brandon-lowe'; // hunter

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};
const rejects = async (label, fn, fragment) => {
  try {
    await fn();
    console.log(`  FAIL ${label} (expected a rejection)`);
    failed++;
  } catch (e) {
    const hit = !fragment || e.message.toLowerCase().includes(fragment.toLowerCase());
    console.log(`  ${hit ? 'ok  ' : 'FAIL'} ${label}${hit ? '' : `: ${e.message}`}`);
    if (!hit) failed++;
  }
};

async function mkt() {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'BTY ' + Math.random()},
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
    values (${slug}, ${S}, ${n}, 'adjustment', 'bounty test')`;
}

async function clean() {
  await sql`delete from bounties where season = ${S}`;
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
  await pts(A, 200);
  await pts(B, 200);
  await pts(C, 200);

  console.log('\nposting');
  const before = await getPoints(A, S);
  const posted = await postBounty({
    slug: A,
    season: S,
    week: W,
    target: B,
    weapon: 'void',
    rewardPoints: 10,
  });

  ok('the points are escrowed immediately', before - (await getPoints(A, S)), 10);
  ok('and it is public', (await openBounties(S, W)).length, 1);
  // The alert copy lives in one place so a banner and a future push notification
  // cannot drift apart.
  ok(
    'the alert reads right',
    posted.alert,
    'BOUNTY ALERT: A bounty has been placed on DEVIN ATTACK: The Void REWARD: 10 Points',
  );

  console.log('\nrules');
  await rejects(
    'cannot bounty yourself',
    () => postBounty({ slug: A, season: S, week: W, target: A, weapon: 'void', rewardPoints: 5 }),
    'on yourself',
  );
  await rejects(
    'has to name an attack',
    () =>
      postBounty({ slug: A, season: S, week: W, target: B, weapon: 'insurance', rewardPoints: 5 }),
    'name an attack',
  );
  await rejects(
    'cannot double up on the same weapon',
    () => postBounty({ slug: A, season: S, week: W, target: B, weapon: 'void', rewardPoints: 5 }),
    'already a',
  );
  await rejects(
    'cannot post what you cannot cover',
    () =>
      postBounty({ slug: A, season: S, week: W, target: B, weapon: 'payout-cut', rewardPoints: 99999 }),
    'not enough points',
  );

  console.log('\nthe wrong weapon earns nothing');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 5000 });
    const cBefore = await getPoints(C, S);
    const skim = await buyBoost({ slug: C, season: S, kind: 'payout-cut' });
    const res = await useBoostOnBet({
      slug: C,
      boostId: Number(skim.id),
      betId: Number(bet.id),
      season: S,
    });
    ok('a skim collects nothing from a Void bounty', res.bounties, []);
    // They paid for the boost, so they are DOWN, not level.
    ok('and they are out the cost of the boost', (await getPoints(C, S)) < cBefore, true);
    ok('the bounty is still open', (await openBounties(S, W)).length, 1);
  }

  console.log('\nthe right weapon collects');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 5000 });
    const cBefore = await getPoints(C, S);
    const voidBoost = await buyBoost({ slug: C, season: S, kind: 'void' });
    const cost = 12;
    const res = await useBoostOnBet({
      slug: C,
      boostId: Number(voidBoost.id),
      betId: Number(bet.id),
      season: S,
    });

    ok('one bounty collected', res.bounties.length, 1);
    ok('for the posted reward', res.bounties[0].reward, 10);
    // Spent 12 on the weapon, collected 10 -- so a bounty offsets an attack
    // rather than paying for it outright, unless it is a big one.
    ok('net of the boost', (await getPoints(C, S)) - cBefore, 10 - cost);
    ok('and it is closed', (await openBounties(S, W)).length, 0);
  }

  console.log('\nyou cannot collect your own');
  {
    await postBounty({ slug: A, season: S, week: W, target: B, weapon: 'payout-cut', rewardPoints: 8 });
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 4000 });
    const skim = await buyBoost({ slug: A, season: S, kind: 'payout-cut' });
    const res = await useBoostOnBet({
      slug: A,
      boostId: Number(skim.id),
      betId: Number(bet.id),
      season: S,
    });
    ok('the poster collects nothing', res.bounties, []);
    ok('and it stays open', (await openBounties(S, W)).length, 1);
  }

  console.log('\nunclaimed bounties refund');
  {
    const aBefore = await getPoints(A, S);
    const n = await expireBounties(S, W);
    ok('one expired', n, 1);
    ok('and the points went home', (await getPoints(A, S)) - aBefore, 8);
    ok('nothing left open', (await openBounties(S, W)).length, 0);
  }

  console.log('\na person-targeted attack collects too');
  {
    await postBounty({
      slug: A,
      season: S,
      week: W,
      target: B,
      weapon: 'slow-play',
      rewardPoints: 6,
    });
    const slow = await buyBoost({ slug: C, season: S, kind: 'slow-play' });
    const res = await slowPlay({ slug: C, boostId: Number(slow.id), target: B, week: W });
    ok('slow play claims its bounty', res.bounties.length, 1);
    ok('for the right amount', res.bounties[0].reward, 6);
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
