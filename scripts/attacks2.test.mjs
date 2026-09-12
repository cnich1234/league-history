/**
 * Slow Play and Switcheroo.
 *
 * Both hit something no other attack touches:
 *
 *   Slow Play doubles what the next bet COSTS, which comes out of the weekly
 *   allowance rather than the payout. It is the only attack that makes someone
 *   poorer rather than making their winnings smaller.
 *
 *   Switcheroo moves a bet to a different option. Two-sided markets flip; a
 *   ten-way special lands somewhere random, which is far worse. The attacker
 *   cannot see what they are moving, so it is as likely to rescue a dead bet as
 *   to kill a winner.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, placeParlay, weeklyBalance } from '../lib/book.js';
import { BOOSTS } from '../lib/boosts.js';
import {
  buyBoost,
  useBoostOnBet,
  switcheroo,
  slowPlay,
  pendingSlowPlay,
  undoBet,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9983;
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

async function mkt(optionCount = 2) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, ${optionCount > 2 ? 'special' : 'h2h'}, ${'A2 ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  for (let i = 0; i < optionCount; i++) {
    await sql`
      insert into market_options (market_id, option_key, label, odds)
      values (${m.id}, ${'opt' + i}, ${'Option ' + i}, ${200 + i * 10})`;
  }
  return Number(m.id);
}

async function pts(slug, n) {
  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${slug}, ${S}, ${n}, 'adjustment', 'attack2 test')`;
}

async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => r.id);
  const bids = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  // Parlay legs reference market_options, so they have to go before the
  // options do -- and a parlay bet has no market_id, so it is not in `bids`.
  const parlayIds = ids.length
    ? (await sql`select distinct bet_id from parlay_legs where market_id = any(${ids})`).map(
        (r) => r.bet_id,
      )
    : [];
  if (ids.length) await sql`delete from parlay_legs where market_id = any(${ids})`;
  if (parlayIds.length) {
    await sql`delete from boosts where target_bet_id = any(${parlayIds})`;
    await sql`delete from ledger where bet_id = any(${parlayIds})`;
    await sql`delete from bets where id = any(${parlayIds})`;
  }
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
  // The persistence case funds and bets in the following week too.
  await unfundWeek(W + 1);
}

await clean();
await fundWeek(W);

try {
  // Enough for a dozen of the dearest boost. Seeded from the catalogue: a
  // fixed number starves these tests the moment prices go up.
  const PURSE = Math.max(...BOOSTS.map((b) => b.cost)) * 12;
  await pts(A, PURSE);
  await pts(B, PURSE);

  console.log('\nSlow Play doubles the next stake');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });
    ok('B is slowed', (await pendingSlowPlay(B, W)) != null, true);

    const before = await weeklyBalance(B, W);
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 10000 });

    ok('the bet is the size they asked for', Number(bet.stake_cents), 10000);
    // The allowance, not the payout: it cost twice as much to place.
    ok('but it cost double', before - (await weeklyBalance(B, W)), 20000);
    ok('and the slow is used up', await pendingSlowPlay(B, W), null);

    const after = await weeklyBalance(B, W);
    const m2 = await mkt();
    await placeBet({ slug: B, marketId: m2, optionKey: 'opt0', stakeCents: 10000 });
    ok('the next bet is normal again', after - (await weeklyBalance(B, W)), 10000);
  }

  console.log('\nundoing a slowed bet returns what it COST');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });
    const m = await mkt();
    const before = await weeklyBalance(B, W);
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 8000 });
    ok('charged double', before - (await weeklyBalance(B, W)), 16000);

    const undo = await buyBoost({ slug: B, season: S, kind: 'undo' });
    const res = await undoBet({ slug: B, boostId: Number(undo.id), betId: Number(bet.id) });
    // Refunding the nominal stake would quietly cost them 8000.
    ok('refunds the full cost, not the nominal stake', res.refundedCents, 16000);
    ok('the week is whole again', await weeklyBalance(B, W), before);
  }

  console.log('\na cheap bet does not wear it off');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });

    // The dodge this floor exists to close: the $10 table minimum used to
    // discharge a 5-point attack for $10 of a $500 week.
    const m = await mkt();
    const before = await weeklyBalance(B, W);
    await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 1000 });
    ok('a minimum bet is charged normally', before - (await weeklyBalance(B, W)), 1000);
    ok('and the slow is still waiting', (await pendingSlowPlay(B, W)) != null, true);

    // A cent under the floor is still not enough.
    const m2 = await mkt();
    const mid = await weeklyBalance(B, W);
    await placeBet({ slug: B, marketId: m2, optionKey: 'opt0', stakeCents: 4999 });
    ok('$49.99 is not enough either', mid - (await weeklyBalance(B, W)), 4999);
    ok('still waiting', (await pendingSlowPlay(B, W)) != null, true);

    // Exactly the floor does it -- the boundary is inclusive.
    const m3 = await mkt();
    const at = await weeklyBalance(B, W);
    await placeBet({ slug: B, marketId: m3, optionKey: 'opt0', stakeCents: 5000 });
    ok('exactly $50 is doubled', at - (await weeklyBalance(B, W)), 10000);
    ok('and wears it off', await pendingSlowPlay(B, W), null);
  }

  console.log('\na parlay cannot slip past it');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });

    // placeParlay is a separate path from placeBet and never consulted Slow
    // Play at all -- a $500 parlay at face value, boost still sitting there.
    const legs = [
      { marketId: await mkt(), optionKey: 'opt0' },
      { marketId: await mkt(), optionKey: 'opt0' },
    ];
    const before = await weeklyBalance(B, W);
    const par = await placeParlay({ slug: B, legs, stakeCents: 6000 });
    ok('the parlay is the size they asked for', Number(par.stake_cents), 6000);
    ok('but it cost double', before - (await weeklyBalance(B, W)), 12000);
    ok('and it wore the slow off', await pendingSlowPlay(B, W), null);
  }

  console.log('\nand a cheap parlay does not wear it off either');
  {
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });
    const legs = [
      { marketId: await mkt(), optionKey: 'opt0' },
      { marketId: await mkt(), optionKey: 'opt0' },
    ];
    const before = await weeklyBalance(B, W);
    await placeParlay({ slug: B, legs, stakeCents: 2000 });
    ok('charged face value', before - (await weeklyBalance(B, W)), 2000);
    ok('still slowed', (await pendingSlowPlay(B, W)) != null, true);

    // Wear it off before the next block, which needs a clean target: only one
    // Slow Play may be pending against someone at a time.
    const m = await mkt();
    await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 5000 });
    ok('cleared for the next case', await pendingSlowPlay(B, W), null);
  }

  console.log('\nit survives the week it was thrown in');
  {
    await fundWeek(W + 1);
    const slow = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(slow.id), target: B, week: W });

    // It used to be scoped to its own week, so anyone hit late on a Sunday
    // could wait it out for free and the attacker's 5 points bought nothing.
    ok('still pending the following week', (await pendingSlowPlay(B, W + 1)) != null, true);

    const m = await sql`
      insert into markets (season, week, kind, title, locks_at, status, live, meta)
      values (${S}, ${W + 1}, 'h2h', ${'A2 next ' + Math.random()},
              ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
      returning id`;
    await sql`
      insert into market_options (market_id, option_key, label, odds)
      values (${m[0].id}, 'opt0', 'Option 0', 200), (${m[0].id}, 'opt1', 'Option 1', 210)`;

    const before = await weeklyBalance(B, W + 1);
    await placeBet({ slug: B, marketId: Number(m[0].id), optionKey: 'opt0', stakeCents: 20000 });
    ok('and it bites next week', before - (await weeklyBalance(B, W + 1)), 40000);
    ok('then it is gone', await pendingSlowPlay(B, W + 1), null);
  }

  console.log('\nand cannot be stacked across weeks');
  {
    const s1 = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await slowPlay({ slug: A, boostId: Number(s1.id), target: B, week: W });
    const s2 = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    // The guard used to be per-week, which with a persisting slow would let
    // them pile up on somebody who never bets big.
    await rejects(
      'a second slow in a later week is refused',
      () => slowPlay({ slug: A, boostId: Number(s2.id), target: B, week: W + 1 }),
      'already slowed',
    );

    // Clear it so the next block starts clean.
    const m = await mkt();
    await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 5000 });
    ok('cleared for the next case', await pendingSlowPlay(B, W), null);
  }

  console.log('\nSlow Play rules');
  {
    const sNull = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await rejects(
      'a slow with no week is refused',
      () => slowPlay({ slug: A, boostId: Number(sNull.id), target: B, week: null }),
      'not valid',
    );

    const s2 = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await rejects(
      'cannot slow yourself',
      () => slowPlay({ slug: A, boostId: Number(s2.id), target: A, week: W }),
      'someone else',
    );
    await slowPlay({ slug: A, boostId: Number(s2.id), target: B, week: W });
    const s3 = await buyBoost({ slug: A, season: S, kind: 'slow-play' });
    await rejects(
      'cannot stack two on one person',
      () => slowPlay({ slug: A, boostId: Number(s3.id), target: B, week: W }),
      'already slowed',
    );
  }

  console.log('\nSwitcheroo flips a two-sided bet');
  {
    const m = await mkt(2);
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 5000 });
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    const res = await switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(bet.id) });

    ok('only one place it could go', res.outOf, 1);
    ok('and it went there', res.to, 'opt1');
    const [moved] = await sql`select option_key, odds from bets where id = ${bet.id}`;
    ok('the bet moved', moved.option_key, 'opt1');
    // The price moves with it: their stake now rides what THAT option was worth.
    ok('and took the new price', moved.odds, 210);
  }

  console.log('\nand lands randomly on a ten-way special');
  {
    const m = await mkt(10);
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'opt0', stakeCents: 5000 });
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    const res = await switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(bet.id) });

    ok('nine other places it could land', res.outOf, 9);
    ok('and it is not where it started', res.to !== 'opt0', true);
  }

  console.log('\nSwitcheroo moves ONE leg of a parlay');
  {
    const legs = [
      { marketId: await mkt(2), optionKey: 'opt0' },
      { marketId: await mkt(2), optionKey: 'opt0' },
      { marketId: await mkt(2), optionKey: 'opt0' },
    ];
    const par = await placeParlay({ slug: B, legs, stakeCents: 5000 });
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    const res = await switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(par.id) });

    ok('it reports three legs to choose from', res.legs, 3);

    const after = await sql`
      select market_id, option_key, odds from parlay_legs where bet_id = ${Number(par.id)}
      order by market_id`;
    const moved = after.filter((l) => l.option_key !== 'opt0');
    ok('exactly one leg moved', moved.length, 1);
    ok('and it took the new price', Number(moved[0].odds), 210);
    // The other two are untouched: a switcheroo is one leg, not a reshuffle.
    ok('the rest are where they were', after.filter((l) => l.option_key === 'opt0').length, 2);

    // The parlay itself is unchanged -- only a leg moved.
    const [row] = await sql`select stake_cents, status from bets where id = ${Number(par.id)}`;
    ok('the stake is untouched', Number(row.stake_cents), 5000);
    ok('and it is still pending', row.status, 'pending');
  }

  console.log('\na settled leg cannot be moved');
  {
    const live = await mkt(2);
    const done = await mkt(2);
    const par = await placeParlay({
      slug: B,
      legs: [
        { marketId: live, optionKey: 'opt0' },
        { marketId: done, optionKey: 'opt0' },
      ],
      stakeCents: 4000,
    });
    // Decide one leg. Only the other is eligible now.
    await sql`
      update parlay_legs set status = 'won', settled_at = now()
      where bet_id = ${Number(par.id)} and market_id = ${done}`;

    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    const res = await switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(par.id) });
    ok('only the live leg was on offer', res.legs, 1);

    const [settledLeg] = await sql`
      select option_key from parlay_legs
      where bet_id = ${Number(par.id)} and market_id = ${done}`;
    ok('the decided leg is untouched', settledLeg.option_key, 'opt0');
    const [liveLeg] = await sql`
      select option_key from parlay_legs
      where bet_id = ${Number(par.id)} and market_id = ${live}`;
    ok('the live one moved', liveLeg.option_key, 'opt1');
  }

  console.log('\nand a fully decided parlay is refused');
  {
    const par = await placeParlay({
      slug: B,
      legs: [
        { marketId: await mkt(2), optionKey: 'opt0' },
        { marketId: await mkt(2), optionKey: 'opt0' },
      ],
      stakeCents: 3000,
    });
    await sql`
      update parlay_legs set status = 'won', settled_at = now()
      where bet_id = ${Number(par.id)}`;
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    await rejects(
      'nothing left to move',
      () => switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(par.id) }),
      'already been decided',
    );
  }

  console.log('\nit can rebound onto a parlay too');
  {
    // A mirrored target, and the attacker's own biggest open bet is a PARLAY.
    // Before parlays were switchable this path threw rather than rebounding.
    const mine = await placeParlay({
      slug: A,
      legs: [
        { marketId: await mkt(2), optionKey: 'opt0' },
        { marketId: await mkt(2), optionKey: 'opt0' },
      ],
      stakeCents: 40000,
    });
    const guarded = await placeBet({
      slug: B,
      marketId: await mkt(2),
      optionKey: 'opt0',
      stakeCents: 3000,
    });
    const mirror = await buyBoost({ slug: B, season: S, kind: 'mirror' });
    await useBoostOnBet({ slug: B, boostId: Number(mirror.id), betId: Number(guarded.id) , atPlacement: true });

    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    const res = await switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(guarded.id) });
    ok('it rebounded', res.reflected, true);
    ok('onto the attacker own parlay', res.betId, String(mine.id));

    const legs = await sql`
      select option_key from parlay_legs where bet_id = ${Number(mine.id)}`;
    ok('one of their own legs moved', legs.filter((l) => l.option_key !== 'opt0').length, 1);

    // And the bet they aimed at is untouched.
    const [target] = await sql`select option_key from bets where id = ${Number(guarded.id)}`;
    ok('the mirrored bet stayed put', target.option_key, 'opt0');
  }

  console.log('\nSwitcheroo rules');
  {
    const m = await mkt();
    const own = await placeBet({ slug: A, marketId: m, optionKey: 'opt0', stakeCents: 4000 });
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    await rejects(
      'cannot switch your own bet',
      () => switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(own.id) }),
      'someone else',
    );

    const m2 = await mkt();
    const safe = await placeBet({ slug: B, marketId: m2, optionKey: 'opt0', stakeCents: 4000 });
    const shield = await buyBoost({ slug: B, season: S, kind: 'insurance' });
    await useBoostOnBet({ slug: B, boostId: Number(shield.id), betId: Number(safe.id) , atPlacement: true });
    await rejects(
      'insurance blocks it',
      () => switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(safe.id) }),
      'insured',
    );
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
