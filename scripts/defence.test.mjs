/**
 * The three defensive boosts.
 *
 * The catalogue was six attacks against one defence, and that one -- Insurance
 * -- is a blind shield placed before anyone has aimed at you. These fix the
 * balance from three different directions:
 *
 *   Mirror   returns an attack instead of absorbing it
 *   Ghost    hides your bets so there is nothing to aim at
 *   Receipt  tells you who hit you, which changes no money at all
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, attackableBets } from '../lib/book.js';
import {
  buyBoost,
  useBoostOnBet,
  useBoostOnWeek,
  readReceipt,
  mirroredBets,
  biggestOpenBet,
  boostsForBets,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9985;
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

async function mkt() {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'DEF ' + Math.random()},
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
    values (${slug}, ${S}, ${n}, 'adjustment', 'defence test')`;
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

  console.log('\nMirror returns an attack');
  {
    const m1 = await mkt();
    const m2 = await mkt();
    // B has a mirrored bet. A has a bigger one of their own to catch the rebound.
    const guarded = await placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 8000 });
    const attackerBet = await placeBet({
      slug: A,
      marketId: m2,
      optionKey: 'home',
      stakeCents: 30000,
    });

    const mirror = await buyBoost({ slug: B, season: S, kind: 'mirror' });
    await useBoostOnBet({ slug: B, boostId: Number(mirror.id), betId: Number(guarded.id) , atPlacement: true });
    ok('the bet is mirrored', await mirroredBets([Number(guarded.id)]), {
      [guarded.id]: true,
    });

    const skim = await buyBoost({ slug: A, season: S, kind: 'payout-cut' });
    const result = await useBoostOnBet({
      slug: A,
      boostId: Number(skim.id),
      betId: Number(guarded.id),
      season: S,
    });

    ok('the attacker is told it rebounded', result.reflected, true);
    // The damage lands on A's own bet, not B's.
    const held = await boostsForBets([Number(guarded.id), Number(attackerBet.id)]);
    ok('the mirrored bet is untouched', held[guarded.id] ?? [], ['mirror']);
    ok('the attacker takes it instead', held[attackerBet.id], ['payout-cut']);
  }

  console.log('\nit rebounds onto their BIGGEST bet');
  {
    const small = await mkt();
    const big = await mkt();
    const target = await mkt();
    await placeBet({ slug: A, marketId: small, optionKey: 'home', stakeCents: 5000 });
    const biggest = await placeBet({ slug: A, marketId: big, optionKey: 'home', stakeCents: 40000 });
    ok('found the biggest', await biggestOpenBet(A, S), Number(biggest.id));

    const guarded = await placeBet({ slug: B, marketId: target, optionKey: 'home', stakeCents: 6000 });
    const mirror = await buyBoost({ slug: B, season: S, kind: 'mirror' });
    await useBoostOnBet({ slug: B, boostId: Number(mirror.id), betId: Number(guarded.id) , atPlacement: true });

    const void_ = await buyBoost({ slug: A, season: S, kind: 'void' });
    await useBoostOnBet({
      slug: A,
      boostId: Number(void_.id),
      betId: Number(guarded.id),
      season: S,
    });
    const held = await boostsForBets([Number(biggest.id)]);
    ok('the rebound hit it', held[biggest.id]?.includes('void'), true);
  }

  console.log('\nGhost hides a week');
  {
    const m = await mkt();
    await placeBet({ slug: B, marketId: m, optionKey: 'away', stakeCents: 7000 });
    const before = await attackableBets(S, W);
    ok('B is visible to begin with', before.some((r) => r.bettor === B), true);

    const ghost = await buyBoost({ slug: B, season: S, kind: 'ghost' });
    await useBoostOnWeek({ slug: B, boostId: Number(ghost.id), week: W });

    const after = await attackableBets(S, W);
    ok('and gone afterwards', after.some((r) => r.bettor === B), false);
    // Everyone else is unaffected -- it hides one manager, not the board.
    ok('others still show', after.some((r) => r.bettor === A), true);
  }

  console.log('\nReceipt names the attacker');
  {
    const m = await mkt();
    const hit = await placeBet({ slug: A, marketId: m, optionKey: 'home', stakeCents: 9000 });
    const skim = await buyBoost({ slug: B, season: S, kind: 'payout-cut' });
    await useBoostOnBet({ slug: B, boostId: Number(skim.id), betId: Number(hit.id), season: S });

    const receipt = await buyBoost({ slug: A, season: S, kind: 'receipt' });
    const found = await readReceipt({ slug: A, boostId: Number(receipt.id), betId: Number(hit.id) });
    ok('one attacker found', found.length, 1);
    ok('and named', found[0].who, 'Devin');
    ok('with the weapon', found[0].kind, 'payout-cut');
  }

  console.log('\nReceipt rules');
  {
    const m = await mkt();
    const theirs = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 5000 });
    const r1 = await buyBoost({ slug: A, season: S, kind: 'receipt' });
    try {
      await readReceipt({ slug: A, boostId: Number(r1.id), betId: Number(theirs.id) });
      ok('refused on someone else', false, true);
    } catch (e) {
      ok('refused on someone else', e.message.includes('your own bets'), true);
    }

    // Spent even when nothing is found: "nobody touched it" is information too,
    // and refunding an empty result would make it a free scan.
    const clean_ = await mkt();
    const untouched = await placeBet({ slug: A, marketId: clean_, optionKey: 'home', stakeCents: 4000 });
    const r2 = await buyBoost({ slug: A, season: S, kind: 'receipt' });
    const none = await readReceipt({ slug: A, boostId: Number(r2.id), betId: Number(untouched.id) });
    ok('finds nobody on a clean bet', none, []);
    const [spent] = await sql`select used_at from boosts where id = ${Number(r2.id)}`;
    ok('and is spent anyway', Boolean(spent.used_at), true);
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
