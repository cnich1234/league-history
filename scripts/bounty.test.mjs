/**
 * Collective bounties: the crowd buys an attack, nobody buys a boost.
 *
 * The first version could not be priced -- a hunter needed reward > cost while
 * the poster needed reward < cost, and those never overlap. Removing the hunter
 * removes the problem: the price is the weapon's list cost, contributions are
 * escrowed, and when they reach the price the attack fires by itself.
 *
 * What these check:
 *
 *   Contributions ESCROW on the way in and REFUND in full if it never fills.
 *   The poster must put in 20%, so posting is not free agenda-setting.
 *   Filling it FIRES the attack, once, without anybody owning a boost.
 *   A bounty dies if its named bet settles first, or if the bet is insured.
 *   A stolen payout SPLITS by what each person put in, to the exact cent.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet } from '../lib/book.js';
import {
  buyBoost,
  useBoostOnBet,
  postBounty,
  contributeToBounty,
  openBounties,
  bountyTotal,
  bountyBackers,
  splitBountyPayout,
  expireBounties,
  cullDeadBountyBets,
  minimumStake,
  getPoints,
} from '../lib/shop.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9982;
const W = testWeek(S);
const A = 'chris-nicholson'; // poster
const B = 'devin-nicholson'; // target
const C = 'brandon-lowe'; // backer
const D = 'kevin-malina'; // backer

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
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => r.id);
  const bids = ids.length
    ? (await sql`select id from bets where market_id = any(${ids})`).map((r) => r.id)
    : [];
  await sql`delete from bounty_contributions where bounty_id in
    (select id from bounties where season = ${S})`;
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
  for (const who of [A, B, C, D]) await pts(who, 200);

  console.log('\nthe stake is 20% of the price');
  ok('a 12-point weapon needs 2', minimumStake(12), 2);
  ok('a 14-point one needs 3', minimumStake(14), 3);
  ok('and nothing rounds to zero', minimumStake(1), 1);

  console.log('\nposting seeds it');
  let bountyId;
  {
    const bet = await placeBet({
      slug: B,
      marketId: await mkt(),
      optionKey: 'home',
      stakeCents: 5000,
    });
    const before = await getPoints(A, S);
    const posted = await postBounty({
      slug: A,
      season: S,
      week: W,
      target: B,
      weapon: 'void',
      betId: Number(bet.id),
      points: 2,
    });
    bountyId = Number(posted.id);

    ok('the price is the weapon, not a typed number', posted.cost, 12);
    ok('the stake is escrowed at once', before - (await getPoints(A, S)), 2);
    ok('and counted', await bountyTotal(bountyId), 2);
    ok('it is public', (await openBounties(S, W)).length, 1);
    ok('with the rest still to raise', (await openBounties(S, W))[0].remaining, 10);
  }

  console.log('\nposting rules');
  {
    const bet = await placeBet({
      slug: B,
      marketId: await mkt(),
      optionKey: 'home',
      stakeCents: 4000,
    });
    await rejects(
      'under 20% is refused',
      () =>
        postBounty({
          slug: A, season: S, week: W, target: B, weapon: 'void',
          betId: Number(bet.id), points: 1,
        }),
      'at least 2',
    );
    await rejects(
      'cannot bounty yourself',
      () =>
        postBounty({
          slug: A, season: S, week: W, target: A, weapon: 'void',
          betId: Number(bet.id), points: 5,
        }),
      'on yourself',
    );
    await rejects(
      'has to name an attack',
      () =>
        postBounty({
          slug: A, season: S, week: W, target: B, weapon: 'insurance',
          betId: Number(bet.id), points: 5,
        }),
      'name an attack',
    );
    // The bet has to belong to the person being hunted.
    const mine = await placeBet({
      slug: A, marketId: await mkt(), optionKey: 'home', stakeCents: 3000,
    });
    await rejects(
      'the bet has to be theirs',
      () =>
        postBounty({
          slug: A, season: S, week: W, target: B, weapon: 'void',
          betId: Number(mine.id), points: 5,
        }),
      'not theirs',
    );
  }

  console.log('\nthe crowd fills it, and it fires');
  {
    // 2 down, 10 to go. Three more backers finish it.
    await contributeToBounty({ slug: C, season: S, bountyId, points: 4 });
    ok('still open at 6', (await openBounties(S, W)).length, 1);
    ok('and short by 6', (await openBounties(S, W))[0].remaining, 6);

    const cBefore = await getPoints(D, S);
    const res = await contributeToBounty({ slug: D, season: S, bountyId, points: 6 });
    ok('the last contribution fills it', res.funded, true);
    ok('it fired', Boolean(res.fired?.fired), true);
    ok('and the escrow came out', cBefore - (await getPoints(D, S)), 6);
    ok('it is off the board', (await openBounties(S, W)).length, 0);

    // The attack exists as a real boost row, so settlement and Receipt see it
    // exactly as they would a bought one.
    const [b] = await sql`select kind, detail from boosts where id = ${Number(res.fired.boostId)}`;
    ok('a boost row was written', b.kind, 'void');
    ok('marked as bounty-funded', b.detail.bounty, String(bountyId));

    await rejects(
      'and it cannot be topped up afterwards',
      () => contributeToBounty({ slug: C, season: S, bountyId, points: 1 }),
      'closed',
    );
  }

  console.log('\ncontributions are capped at what is left');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'payout-cut',
      betId: Number(bet.id), points: 2,
    });
    const id = Number(posted.id);
    // Skim costs 8, 2 is down, so 6 remain. Offering 50 takes only 6.
    const before = await getPoints(C, S);
    const res = await contributeToBounty({ slug: C, season: S, bountyId: id, points: 50 });
    ok('only the shortfall is taken', res.contributed, 6);
    ok('and only that is charged', before - (await getPoints(C, S)), 6);
    ok('which fills it', res.funded, true);
  }

  console.log('\nan unfilled bounty refunds in full');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'switcheroo',
      betId: Number(bet.id), points: 3,
    });
    await contributeToBounty({ slug: C, season: S, bountyId: Number(posted.id), points: 4 });

    const aBefore = await getPoints(A, S);
    const cBefore = await getPoints(C, S);
    const n = await expireBounties(S, W);
    ok('one expired', n, 1);
    // Full refund, by decision: charging for an unfilled bounty would make
    // people lowball rather than post a real one.
    ok('the poster is whole', (await getPoints(A, S)) - aBefore, 3);
    ok('and so is the backer', (await getPoints(C, S)) - cBefore, 4);
    ok('nothing left open', (await openBounties(S, W)).length, 0);
  }

  console.log('\na bounty dies with its bet');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'void',
      betId: Number(bet.id), points: 2,
    });
    const before = await getPoints(A, S);

    // The bet settles while the bounty is still filling.
    await sql`update bets set status = 'won' where id = ${Number(bet.id)}`;
    const culled = await cullDeadBountyBets(S, W);
    ok('it was culled', culled, 1);
    ok('and refunded', (await getPoints(A, S)) - before, 2);
    ok('gone from the board', (await openBounties(S, W)).length, 0);
    const [row] = await sql`select status, closed_reason from bounties where id = ${Number(posted.id)}`;
    ok('marked void', row.status, 'void');
  }

  console.log('\ninsurance blocks it, and everyone gets their points back');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    const shield = await buyBoost({ slug: B, season: S, kind: 'insurance' });
    await useBoostOnBet({ slug: B, boostId: Number(shield.id), betId: Number(bet.id) });

    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'void',
      betId: Number(bet.id), points: 2,
    });
    const aBefore = await getPoints(A, S);
    const cBefore = await getPoints(C, S);
    const res = await contributeToBounty({
      slug: C, season: S, bountyId: Number(posted.id), points: 10,
    });

    ok('it did not land', Boolean(res.fired?.refunded), true);
    ok('because of the shield', res.fired.why, 'the bet was insured');
    // Net zero for both: charged on the way in, refunded on the way out.
    ok('the poster is square', (await getPoints(A, S)) - aBefore, 2);
    ok('and the backer too', (await getPoints(C, S)) - cBefore, 0);
  }

  console.log('\na stolen payout splits by what each put in');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    // Grand Theft costs 9. Poster 2, then 3 and 4.
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'steal',
      betId: Number(bet.id), points: 2,
    });
    const id = Number(posted.id);
    await contributeToBounty({ slug: C, season: S, bountyId: id, points: 3 });
    const res = await contributeToBounty({ slug: D, season: S, bountyId: id, points: 4 });
    ok('it fired', Boolean(res.fired?.fired), true);

    const backers = await bountyBackers(id);
    ok('three backers', backers.length, 3);

    // 10000 cents split 2:3:4 of 9 -> 2222 / 3333 / 4444, remainder 1 to the
    // largest share so the parts add back to the payout exactly.
    const shares = await splitBountyPayout(id, 10000);
    const byWho = Object.fromEntries(shares.map((s) => [s.slug, s.cents]));
    ok('the largest share leads', shares[0].slug, D);
    ok('and takes the remainder', byWho[D], 4445);
    ok('the middle share', byWho[C], 3333);
    ok('the poster share', byWho[A], 2222);
    ok('and it all adds up', shares.reduce((n, s) => n + s.cents, 0), 10000);
  }

  console.log('\nyou cannot fund a bounty on yourself');
  {
    const bet = await placeBet({
      slug: B, marketId: await mkt(), optionKey: 'home', stakeCents: 5000,
    });
    const posted = await postBounty({
      slug: A, season: S, week: W, target: B, weapon: 'blind-sabotage',
      betId: Number(bet.id), points: 1,
    });
    await rejects(
      'the target is refused',
      () => contributeToBounty({ slug: B, season: S, bountyId: Number(posted.id), points: 2 }),
      'on yourself',
    );
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
