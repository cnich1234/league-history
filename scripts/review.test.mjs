/**
 * Rules that the code review found were promised and not kept.
 *
 *   A shield goes on BEFORE the hit or not at all.
 *   Only an ATTACK marks a bet as hit -- Better Price is not a shield.
 *   A market is in a parlay or bet straight, never both.
 *   A crowd-funded Switcheroo moves the bet. A bounty cannot poison a market.
 *   A bounty never holds more than its price.
 *   A Mirror sends a crowd attack back at the poster.
 *   Grand Theft, Cut of the Action and Big Week reach a PARLAY.
 *
 * Sentinel season, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, placeParlay, settleMarket, attackableBets } from '../lib/book.js';
import { byKind } from '../lib/boosts.js';
import {
  buyBoost,
  useBoostOnBet,
  useBoostOnWeek,
  postBounty,
  contributeToBounty,
  bountyTotal,
  getPoints,
  cashOut,
} from '../lib/shop.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9981;
const W = testWeek(S);
const A = 'chris-nicholson';
const B = 'devin-nicholson';
const C = 'brandon-lowe';

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

async function mkt({ live = false, options = null } = {}) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'RV ' + Math.random()},
            ${new Date(Date.now() + 86400e3)}, 'open', ${live}, '{}'::jsonb)
    returning id`;
  const opts = options ?? [
    ['home', 'Home', 100],
    ['away', 'Away', -120],
  ];
  for (const [k, l, o] of opts) {
    await sql`insert into market_options (market_id, option_key, label, odds)
              values (${m.id}, ${k}, ${l}, ${o})`;
  }
  return Number(m.id);
}
const give = async (slug, pts) =>
  sql`insert into point_ledger (bettor, season, amount, reason, note)
      values (${slug}, ${S}, ${pts}, 'adjustment', 'review test')`;
const bank = async (slug) => {
  const [r] = await sql`
    select coalesce(sum(l.amount_cents), 0)::bigint as c from ledger l
    where l.bettor = ${slug} and l.week is null and l.note in
      ('Winnings banked', 'Stolen bet', 'Cut of the action')
      and l.bet_id in (select id from bets where id in (select bet_id from parlay_legs
        where market_id in (select id from markets where season = ${S}))
        or market_id in (select id from markets where season = ${S}))`;
  return Number(r.c);
};

async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => Number(r.id));
  const betIds = ids.length
    ? (
        await sql`
          select id from bets where market_id = any(${ids})
          union select bet_id from parlay_legs where market_id = any(${ids})`
      ).map((r) => Number(r.id))
    : [];
  if (betIds.length) {
    await sql`delete from ledger where bet_id = any(${betIds})`;
    await sql`delete from bounty_contributions where bounty_id in
              (select id from bounties where season = ${S})`;
    await sql`delete from bounties where season = ${S}`;
    await sql`update boosts set target_bet_id = null where target_bet_id = any(${betIds})`;
    await sql`delete from parlay_legs where bet_id = any(${betIds})`;
    await sql`delete from bets where id = any(${betIds})`;
  }
  await sql`delete from boosts where season = ${S}`;
  await sql`delete from point_ledger where season = ${S}`;
  if (ids.length) {
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await unfundWeek(W);
}

try {
  await clean();
  await fundWeek(W);
  for (const s of [A, B, C]) await give(s, 500);

  console.log('\na shield goes on before the hit, or not at all');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const skim = await buyBoost({ slug: A, season: S, kind: 'payout-cut' });
    await useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: Number(bet.id) });
    const ins = await buyBoost({ slug: B, season: S, kind: 'insurance' });
    await rejects(
      'Insurance refused after a Skim has landed',
      () => useBoostOnBet({ slug: B, boostId: Number(ins.id), betId: Number(bet.id) , atPlacement: true }),
      'too late',
    );
    const m2 = await mkt();
    const bet2 = await placeBet({ slug: B, marketId: m2, optionKey: 'home', stakeCents: 2000 });
    await useBoostOnBet({ slug: B, boostId: Number(ins.id), betId: Number(bet2.id) , atPlacement: true });
    ok('but still attaches to an untouched bet', true, true);
  }

  console.log('\nonly an attack counts as a hit');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const half = await buyBoost({ slug: B, season: S, kind: 'boost-50' });
    await useBoostOnBet({ slug: B, boostId: Number(half.id), betId: Number(bet.id) , atPlacement: true });
    const rows = await attackableBets(S, W);
    const row = rows.find((r) => Number(r.id) === Number(bet.id));
    ok('Half Again does not read as attacked', Number(row?.attacked), 0);
    const void_ = await buyBoost({ slug: A, season: S, kind: 'void' });
    await useBoostOnBet({ slug: A, boostId: Number(void_.id), betId: Number(bet.id) });
    const after = (await attackableBets(S, W)).find((r) => Number(r.id) === Number(bet.id));
    ok('The Void does', Number(after?.attacked), 1);
  }

  console.log('\na market is in a parlay or bet straight, never both');
  {
    const m1 = await mkt();
    const m2 = await mkt();
    await placeParlay({
      slug: A,
      stakeCents: 2000,
      legs: [
        { marketId: m1, optionKey: 'home' },
        { marketId: m2, optionKey: 'home' },
      ],
    });
    await rejects(
      'straight bet refused on a market in your parlay',
      () => placeBet({ slug: A, marketId: m1, optionKey: 'away', stakeCents: 1000 }),
      'parlay',
    );
    const m3 = await mkt();
    await placeBet({ slug: A, marketId: m3, optionKey: 'home', stakeCents: 1000 });
    const m4 = await mkt();
    await rejects(
      'parlay leg refused on a market you bet straight',
      () =>
        placeParlay({
          slug: A,
          stakeCents: 2000,
          legs: [
            { marketId: m3, optionKey: 'away' },
            { marketId: m4, optionKey: 'home' },
          ],
        }),
      'straight bet',
    );
  }

  console.log('\na crowd-funded Switcheroo moves the bet');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const cost = byKind['switcheroo'].cost;
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'switcheroo', betId: Number(bet.id),
    });
    const state = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: cost,
    });
    ok('it fired', state.fired?.fired, true);
    const [moved] = await sql`select option_key from bets where id = ${Number(bet.id)}`;
    ok('and the bet is on the other side', moved.option_key, 'away');
  }
  await rejects(
    'a bounty cannot poison a market',
    () => postBounty({ slug: A, season: S, week: W, target: B, weapon: 'market-poison' }),
    'cannot be a bounty',
  );

  console.log('\na contribution is capped at what is left');
  {
    // The overpay guard in contributeToBounty only fires when two fills race
    // past the price at once, which a single-threaded test cannot drive. What
    // it CAN check is the cap that makes the race rare: a contribution never
    // takes more than the room left, and a full bounty refuses a top-up.
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const cost = byKind['blind-sabotage'].cost;
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'blind-sabotage', betId: Number(bet.id),
    });
    const room = cost - (await bountyTotal(Number(posted.id)));
    const before = await getPoints(C, S);
    const state = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: room + 40,
    });
    ok('took only the room, not the offer', state.contributed, room);
    ok('charged only that much', before - (await getPoints(C, S)), room);
    ok('and it fired', state.fired?.fired, true);
    await rejects(
      'a top-up on a full bounty is refused',
      () => contributeToBounty({ slug: A, season: S, bountyId: Number(posted.id), points: 1 }),
      'closed',
    );
  }

  console.log('\na Mirror sends a crowd attack back at the poster');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const mirror = await buyBoost({ slug: B, season: S, kind: 'mirror' });
    await useBoostOnBet({ slug: B, boostId: Number(mirror.id), betId: Number(bet.id) , atPlacement: true });
    // The poster has an open bet of their own for it to land on.
    const mine = await mkt();
    const own = await placeBet({ slug: A, marketId: mine, optionKey: 'home', stakeCents: 3000 });
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'payout-cut', betId: Number(bet.id),
    });
    const cBefore = await getPoints(C, S);
    const state = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: byKind['payout-cut'].cost,
    });
    ok('it fired, reflected', [state.fired?.fired, state.fired?.reflected], [true, true]);
    // Every backer takes the hit. A had an open bet: the Skim lands on it, as
    // A's own row. C had none: C is refunded rather than let off.
    ok("it landed on the poster's own biggest bet", state.fired.landedOn, [{ slug: A, betId: String(own.id) }]);
    const [onA] = await sql`
      select owner, detail from boosts where target_bet_id = ${Number(own.id)} and kind = 'payout-cut'`;
    ok('as their own attack, with no bounty marker', [onA.owner, onA.detail.bounty ?? null, onA.detail.reflected], [A, null, true]);
    ok('the backer with nothing to rebound onto was refunded', state.fired.refunded, [C]);
    ok('to the point', await getPoints(C, S), cBefore);
    const [victim] = await sql`
      select count(*)::int as n from boosts where target_bet_id = ${Number(bet.id)} and kind = 'payout-cut'`;
    ok('nothing on the mirrored bet', victim.n, 0);
  }

  console.log('\nInsurance, Half Again and Mirror are slip-only');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    for (const kind of ['insurance', 'boost-50', 'mirror']) {
      const b = await buyBoost({ slug: B, season: S, kind });
      await rejects(
        `${kind} refused after placement`,
        () => useBoostOnBet({ slug: B, boostId: Number(b.id), betId: Number(bet.id) }),
        'when you place the bet',
      );
      await useBoostOnBet({ slug: B, boostId: Number(b.id), betId: Number(bet.id), atPlacement: true });
      ok(`${kind} attaches at placement`, true, true);
    }
  }

  console.log('\nGrand Theft reaches a parlay');
  {
    const m1 = await mkt();
    const m2 = await mkt();
    const parlay = await placeParlay({
      slug: B,
      stakeCents: 2000,
      legs: [
        { marketId: m1, optionKey: 'home' },
        { marketId: m2, optionKey: 'home' },
      ],
    });
    const steal = await buyBoost({ slug: A, season: S, kind: 'steal' });
    await useBoostOnBet({ slug: A, boostId: Number(steal.id), betId: Number(parlay.id) });
    await settleMarket(m1, 'home');
    await settleMarket(m2, 'home');
    const [row] = await sql`select status, payout_cents from bets where id = ${Number(parlay.id)}`;
    ok('the parlay won', row.status, 'won');
    const [thief] = await sql`
      select coalesce(sum(amount_cents), 0)::bigint as c from ledger
      where bet_id = ${Number(parlay.id)} and bettor = ${A} and reason = 'payout'`;
    const [victim] = await sql`
      select coalesce(sum(amount_cents), 0)::bigint as c from ledger
      where bet_id = ${Number(parlay.id)} and bettor = ${B} and reason = 'payout'`;
    ok('the thief was paid the whole payout', Number(thief.c), Number(row.payout_cents));
    ok('the victim got nothing', Number(victim.c), 0);
  }

  console.log('\nCut of the Action and Big Week reach a parlay');
  {
    const m1 = await mkt();
    const m2 = await mkt();
    const big = await buyBoost({ slug: B, season: S, kind: 'boost-week' });
    await useBoostOnWeek({ slug: B, boostId: Number(big.id), week: W });
    const parlay = await placeParlay({
      slug: B,
      stakeCents: 2000,
      legs: [
        { marketId: m1, optionKey: 'home' },
        { marketId: m2, optionKey: 'home' },
      ],
    });
    const tithe = await buyBoost({ slug: A, season: S, kind: 'tithe' });
    await useBoostOnBet({ slug: A, boostId: Number(tithe.id), betId: Number(parlay.id) });
    await settleMarket(m1, 'home');
    await settleMarket(m2, 'home');
    const [row] = await sql`select payout_cents, parlay_odds from bets where id = ${Number(parlay.id)}`;
    const base = payoutCents(2000, Number(row.parlay_odds));
    ok('Big Week multiplied the parlay by 1.5', Number(row.payout_cents), Math.round(base * 1.5));
    const profit = Number(row.payout_cents) - 2000;
    const [cut] = await sql`
      select coalesce(sum(amount_cents), 0)::bigint as c from ledger
      where bet_id = ${Number(parlay.id)} and bettor = ${A} and reason = 'payout'`;
    ok('the tithe took half the profit', Number(cut.c), Math.floor(profit * 0.5));
    const [kept] = await sql`
      select coalesce(sum(amount_cents), 0)::bigint as c from ledger
      where bet_id = ${Number(parlay.id)} and bettor = ${B} and reason = 'payout'`;
    ok('and the owner banked the rest', Number(kept.c), profit - Math.floor(profit * 0.5));
  }

  console.log('\nCash Out settles a live bet at what it is worth');
  {
    // Placed pregame at +100 -- $20 returns $40 -- then the games start.
    const m = await mkt({ live: true });
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    await sql`update markets set locks_at = now() - interval '1 hour' where id = ${m}`;
    const co = await buyBoost({ slug: B, season: S, kind: 'cash-out' });

    // Going well: the side is now -150, a 60% chance. 40 x 0.6 = $24.
    const res = await cashOut({
      slug: B,
      boostId: Number(co.id),
      betId: Number(bet.id),
      priceNow: async () => ({ odds: -150, probability: 0.6 }),
    });
    ok('valued at payout x live probability', res.valueCents, 2400);
    const [row] = await sql`select status, payout_cents from bets where id = ${Number(bet.id)}`;
    ok('the bet is cashed, not won', row.status, 'cashed');
    ok('and records the value', Number(row.payout_cents), 2400);
    const money = await sql`
      select reason, amount_cents, week from ledger where bet_id = ${Number(bet.id)} and amount_cents > 0
      order by reason`;
    ok('stake back to its week', money.find((r) => r.reason === 'refund')?.amount_cents, '2000');
    ok('in the week it came from', money.find((r) => r.reason === 'refund')?.week, W);
    ok('the rest banked', money.find((r) => r.reason === 'payout')?.amount_cents, '400');
    ok('bank rows carry no week', money.find((r) => r.reason === 'payout')?.week, null);

    // Going badly: +300 now, a 25% chance. 40 x 0.25 = $10, less than the stake.
    const m2 = await mkt({ live: true });
    const bet2 = await placeBet({ slug: B, marketId: m2, optionKey: 'home', stakeCents: 2000 });
    await sql`update markets set locks_at = now() - interval '1 hour' where id = ${m2}`;
    const co2 = await buyBoost({ slug: B, season: S, kind: 'cash-out' });
    const res2 = await cashOut({
      slug: B,
      boostId: Number(co2.id),
      betId: Number(bet2.id),
      priceNow: async () => ({ odds: 300, probability: 0.25 }),
    });
    ok('a dying bet cashes for less than its stake', res2.valueCents, 1000);
    const back = await sql`
      select reason, amount_cents from ledger where bet_id = ${Number(bet2.id)} and amount_cents > 0`;
    ok('all of it to the week, nothing banks', back.map((r) => [r.reason, r.amount_cents]), [['refund', '1000']]);

    console.log('\nCash Out rules');
    const m3 = await mkt({ live: true });
    const bet3 = await placeBet({ slug: B, marketId: m3, optionKey: 'home', stakeCents: 2000 });
    const co3 = await buyBoost({ slug: B, season: S, kind: 'cash-out' });
    await rejects(
      'nothing to cash out before kickoff',
      () => cashOut({ slug: B, boostId: Number(co3.id), betId: Number(bet3.id),
                      priceNow: async () => ({ odds: 100, probability: 0.5 }) }),
      'until the games start',
    );
    await sql`update markets set locks_at = now() - interval '1 hour' where id = ${m3}`;
    await rejects(
      'refused when the model has suspended the market',
      () => cashOut({ slug: B, boostId: Number(co3.id), betId: Number(bet3.id), priceNow: async () => null }),
      'no live price',
    );
    await rejects(
      "refused on somebody else's bet",
      () => cashOut({ slug: A, boostId: Number(co3.id), betId: Number(bet3.id),
                      priceNow: async () => ({ odds: 100, probability: 0.5 }) }),
      'not yours',
    );
    const pre = await mkt();
    const bet4 = await placeBet({ slug: B, marketId: pre, optionKey: 'home', stakeCents: 2000 });
    await sql`update markets set locks_at = now() - interval '1 hour' where id = ${pre}`;
    await rejects(
      'refused on a market that is not live',
      () => cashOut({ slug: B, boostId: Number(co3.id), betId: Number(bet4.id),
                      priceNow: async () => ({ odds: 100, probability: 0.5 }) }),
      'only a live bet',
    );
    const [unused] = await sql`select used_at from boosts where id = ${Number(co3.id)}`;
    ok('a refused cash out is not spent', unused.used_at, null);
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
