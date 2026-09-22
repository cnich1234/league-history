/**
 * Settling a week has to finish inside the function limit.
 *
 * Week 2 of 2026 had 176 markets and 48 with a bet or a parlay leg on them.
 * settleMarket does about a dozen queries per market -- bets, boosts, thieves,
 * tithes, bounties, legs -- and for a market nobody backed every one of those
 * returns nothing. At ~1.8s each the run needed five and a half minutes against
 * a 60s limit, so the cron was killed after 32 markets and never reached daily
 * fantasy, the allowance or the trophies. Points appeared to pay while the
 * bets sat pending.
 *
 * So an unbacked market is settled in bulk. The danger is that the two paths
 * disagree about what a settled market looks like, which is what this pins
 * down: same status, same winning_option, same settled_at, whichever path
 * wrote it.
 *
 * Sentinel season, cleaned up in a finally.
 */
import { neon } from '@neondatabase/serverless';
import { settleWeek } from '../lib/cron.js';
import { placeBet, placeParlay } from '../lib/book.js';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';

const sql = neon(process.env.DATABASE_URL);
const S = 9972;
const W = testWeek(S);
const A = 'chris-nicholson';

// Scores are injected rather than fetched: the sentinel week is one the
// Sleeper feed has never heard of. Roster 1 beat roster 6, 120 to 100.
const INPUTS = {
  pointsByRoster: { 1: 120, 6: 100, 2: 111, 7: 90 },
  pointsByPlayer: {},
  startedPlayers: new Set(),
  starterRosters: {},
  positionOf: () => '?',
};

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(
    `  ${match ? 'ok  ' : 'FAIL'} ${label}` +
      (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`),
  );
  if (!match) failed++;
};

async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => Number(r.id));
  if (ids.length) {
    // A parlay's bet row points at no market, so collect its id through the
    // legs as well -- otherwise the legs outlive the market they reference.
    const bets = (
      await sql`
        select id from bets where market_id = any(${ids})
        union
        select bet_id as id from parlay_legs where market_id = any(${ids})`
    ).map((r) => Number(r.id));
    if (bets.length) {
      await sql`delete from parlay_legs where bet_id = any(${bets})`;
      await sql`delete from ledger where bet_id = any(${bets})`;
      await sql`delete from bets where id = any(${bets})`;
    }
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await unfundWeek(W);
}

/** An h2h market on two rosters, with both sides priced. */
async function mkt(home, away) {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'SB ' + Math.random()}, ${new Date(Date.now() + 3600e3)}, 'open', false,
            ${JSON.stringify({ homeRoster: home, awayRoster: away })}::jsonb)
    returning id`;
  for (const [k, l] of [['home', 'Home'], ['away', 'Away']]) {
    await sql`insert into market_options (market_id, option_key, label, odds)
              values (${m.id}, ${k}, ${l}, -110)`;
  }
  return Number(m.id);
}

try {
  await clean();
  await fundWeek(W);

  // Ten markets on the same real matchup, so they all resolve the same way.
  // One carries a bet; the other nine carry nothing.
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(await mkt(1, 6));
  const backedId = ids[0];
  await placeBet({ slug: A, marketId: backedId, optionKey: 'home', stakeCents: 1000 });

  // Kickoff has passed by settlement time.
  await sql`update markets set status = 'locked', locks_at = ${new Date(Date.now() - 3600e3)}
            where season = ${S}`;

  console.log('\nsettling a week where most markets carry no money');
  const t0 = Date.now();
  const res = await settleWeek(sql, S, W, { inputs: INPUTS });
  const elapsed = Date.now() - t0;
  ok('every market is settled', res.settled + res.voided, 10);

  const rows = await sql`
    select id, status, winning_option, settled_at from markets where season = ${S} order by id`;
  ok('none left locked', rows.filter((r) => r.status === 'locked').length, 0);
  ok('all carry a winning option', rows.filter((r) => r.winning_option == null).length, 0);
  ok('all carry a settled_at', rows.filter((r) => r.settled_at == null).length, 0);

  // The whole point: the bulk path and settleMarket must agree.
  const backed = rows.find((r) => Number(r.id) === backedId);
  const others = rows.filter((r) => Number(r.id) !== backedId);
  ok(
    'the unbacked markets match the backed one',
    others.every((r) => r.status === backed.status && r.winning_option === backed.winning_option),
    true,
  );

  console.log('\nthe bet on the backed market still settles properly');
  const [bet] = await sql`select status, payout_cents from bets where market_id = ${backedId}`;
  ok('it is no longer pending', bet.status !== 'pending', true);
  ok('and carries a payout figure', bet.payout_cents != null, true);

  console.log('\nand it is fast enough to finish');
  // Ten markets is a small sample, but a run that spends a second each would
  // never have got through week 2's 176 inside the limit.
  console.log(`  (10 markets in ${elapsed}ms)`);
  ok('well inside the function limit', elapsed < 30_000, true);

  console.log('\na parlay whose legs sit on otherwise-empty markets');
  {
    // settleParlays runs inside settleMarket, and the bulk path never calls
    // it. So a parlay is only safe if every market carrying one of its legs
    // counts as backed -- otherwise its last leg resolves in bulk and the
    // parlay sits pending forever. This is that case: two markets whose only
    // money is a parlay leg, with no straight bet anywhere near them.
    //
    // Different matchups, because two legs on one game are correlated and
    // would be refused before they ever reached settlement.
    const legA = await mkt(1, 6);
    const legB = await mkt(2, 7);
    const { id: betId } = await placeParlay({
      slug: A,
      stakeCents: 1000,
      legs: [
        { marketId: legA, optionKey: 'home' },
        { marketId: legB, optionKey: 'home' },
      ],
    });
    await sql`update markets set status = 'locked', locks_at = ${new Date(Date.now() - 3600e3)}
              where id = any(${[legA, legB]})`;

    await settleWeek(sql, S, W, { inputs: INPUTS });
    const [par] = await sql`select status, payout_cents from bets where id = ${betId}`;
    ok('the parlay settled rather than hanging', par.status, 'won');
    ok('and it was paid', Number(par.payout_cents) > 1000, true);
    const legs = await sql`select status from parlay_legs where bet_id = ${betId}`;
    ok('both legs resolved', legs.map((l) => l.status).sort(), ['won', 'won']);
  }

  console.log('\nrunning it twice changes nothing');
  const again = await settleWeek(sql, S, W, { inputs: INPUTS });
  ok('a settled week settles nothing further', again.settled + again.voided, 0);

  console.log(failed ? `\n${failed} FAILED` : '\nall good');
} finally {
  await clean();
}

process.exit(failed ? 1 : 0);
