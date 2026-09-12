/**
 * Where a bet stands in its game: open, live, locked, closed.
 *
 *   open    nothing has kicked off -- attackable, and the only phase a copy
 *           is allowed in
 *   live    underway and repricing (h2h, spread, total) -- attackable
 *   locked  underway and NOT repricing (prop, showdown, special) -- attackable
 *   closed  every game final -- nothing can be done to it
 *
 * Decided from game state, never from market status or locks_at. The first
 * half is pure and runs on synthetic states; the second injects a phase into
 * the shop functions and checks each rule is enforced where the write happens.
 */
import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { phaseFor, parlayPhase } from '../lib/live.js';
import { placeBet } from '../lib/book.js';
import { buyBoost, useBoostOnBet, rideAlong, switcheroo, postBounty, contributeToBounty } from '../lib/shop.js';
import { byKind } from '../lib/boosts.js';

let failed = 0;
const ok = (label, actual, expected) => {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${match ? 'ok  ' : 'FAIL'} ${label}` + (match ? '' : ` (want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`));
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

/* ---------- the classifier ---------- */

const side = (scored, final) => ({ scored, remaining: final ? 0 : 50, final });
const matchup = (started, homeFinal, awayFinal) => ({
  homeRoster: 1, awayRoster: 2, started,
  home: side(started ? 20 : 0, homeFinal), away: side(started ? 15 : 0, awayFinal),
});
const game = (status) => ({ status, metadata: { has_started: status !== 'pre_game', is_over: status === 'complete' } });

console.log('\nh2h, spread, total -- live markets');
{
  const h2h = { kind: 'h2h', live: true, meta: { homeRoster: 1, awayRoster: 2 } };
  ok('nothing kicked off -> open', phaseFor(h2h, { matchups: { '1-2': matchup(false, false, false) }, games: {} }), 'open');
  ok('scoring -> live', phaseFor(h2h, { matchups: { '1-2': matchup(true, false, false) }, games: {} }), 'live');
  ok('one side final -> still live', phaseFor(h2h, { matchups: { '1-2': matchup(true, true, false) }, games: {} }), 'live');
  ok('both final -> closed', phaseFor(h2h, { matchups: { '1-2': matchup(true, true, true) }, games: {} }), 'closed');
  const total = { kind: 'total', live: true, meta: { rosterId: 2 } };
  ok('a total closes on its own side', phaseFor(total, { matchups: { '1-2': matchup(true, false, true) }, games: {} }), 'closed');
  ok('and not on the other side', phaseFor(total, { matchups: { '1-2': matchup(true, true, false) }, games: {} }), 'live');
}

console.log('\nshowdown, blowout -- non-live markets on a matchup');
{
  const sd = { kind: 'showdown', live: false, meta: { homeRoster: 1, awayRoster: 2, position: 'QB' } };
  ok('not started -> open', phaseFor(sd, { matchups: { '1-2': matchup(false, false, false) }, games: {} }), 'open');
  ok('underway -> locked, not live', phaseFor(sd, { matchups: { '1-2': matchup(true, false, false) }, games: {} }), 'locked');
  ok('both final -> closed', phaseFor(sd, { matchups: { '1-2': matchup(true, true, true) }, games: {} }), 'closed');
}

console.log('\nprops -- one player, one game');
{
  const prop = { kind: 'prop', live: false, meta: { nflTeam: 'KC', playerId: 'x' } };
  ok('pre_game -> open', phaseFor(prop, { matchups: {}, games: { KC: game('pre_game') } }), 'open');
  ok('in progress -> locked', phaseFor(prop, { matchups: {}, games: { KC: game('in_progress') } }), 'locked');
  ok('complete -> closed', phaseFor(prop, { matchups: {}, games: { KC: game('complete') } }), 'closed');
  ok('no game for the team (bye) -> open', phaseFor(prop, { matchups: {}, games: {} }), 'open');
}

console.log('\nspecials -- every lineup');
{
  const sp = { kind: 'special', live: false, meta: { special: 'team' } };
  const two = (a, b) => ({ '1-2': a, '3-4': b });
  ok('nobody started -> open', phaseFor(sp, { matchups: two(matchup(false, false, false), matchup(false, false, false)), games: {} }), 'open');
  ok('one game on -> locked', phaseFor(sp, { matchups: two(matchup(true, false, false), matchup(false, false, false)), games: {} }), 'locked');
  ok('one game done, one on -> locked', phaseFor(sp, { matchups: two(matchup(true, true, true), matchup(true, false, false)), games: {} }), 'locked');
  ok('all done -> closed', phaseFor(sp, { matchups: two(matchup(true, true, true), matchup(true, true, true)), games: {} }), 'closed');
}

console.log('\nparlays -- from their legs');
{
  ok('all open -> open', parlayPhase(['open', 'open'], [true, false]), 'open');
  ok('all closed -> closed', parlayPhase(['closed', 'closed'], [true, true]), 'closed');
  ok('one closed, one open -> not closed', parlayPhase(['closed', 'open'], [true, true]), 'locked');
  ok('a live leg makes it live', parlayPhase(['live', 'open'], [true, false]), 'live');
  ok('a locked prop leg with nothing live -> locked', parlayPhase(['locked', 'open'], [false, false]), 'locked');
}

/* ---------- enforcement ---------- */

const sql = neon(process.env.DATABASE_URL);
const S = 9980;
const W = testWeek(S);
const A = 'chris-nicholson';
const B = 'devin-nicholson';
const give = (slug, pts) => sql`insert into point_ledger (bettor, season, amount, reason, note) values (${slug}, ${S}, ${pts}, 'adjustment', 'phase test')`;
async function mkt() {
  const [m] = await sql`
    insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'PH ' + Math.random()}, ${new Date(Date.now() + 86400e3)}, 'open', false, '{}'::jsonb)
    returning id`;
  await sql`insert into market_options (market_id, option_key, label, odds) values (${m.id}, 'home', 'Home', 100), (${m.id}, 'away', 'Away', -120)`;
  return Number(m.id);
}
async function clean() {
  const ids = (await sql`select id from markets where season = ${S}`).map((r) => Number(r.id));
  if (ids.length) {
    const bets = (await sql`select id from bets where market_id = any(${ids})`).map((r) => Number(r.id));
    if (bets.length) {
      await sql`delete from ledger where bet_id = any(${bets})`;
      await sql`delete from bounty_contributions where bounty_id in (select id from bounties where season = ${S})`;
      await sql`delete from bounties where season = ${S}`;
      await sql`update boosts set target_bet_id = null where target_bet_id = any(${bets})`;
      await sql`delete from bets where id = any(${bets})`;
    }
    await sql`delete from market_options where market_id = any(${ids})`;
    await sql`delete from markets where id = any(${ids})`;
  }
  await sql`delete from boosts where season = ${S}`;
  await sql`delete from point_ledger where season = ${S}`;
  await unfundWeek(W);
}
const closed = async () => 'closed';
const open = async () => 'open';
const live = async () => 'live';

try {
  await clean();
  await fundWeek(W);
  await give(A, 300);
  await give(B, 300);
  await give('brandon-lowe', 300);

  console.log('\nno attack on a finished game');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const skim = await buyBoost({ slug: A, season: S, kind: 'payout-cut' });
    await rejects('Skim refused when closed', () => useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: Number(bet.id), phaseOf: closed }), 'game is over');
    const [unused] = await sql`select used_at from boosts where id = ${Number(skim.id)}`;
    ok('and the boost is not spent', unused.used_at, null);
    await useBoostOnBet({ slug: A, boostId: Number(skim.id), betId: Number(bet.id), phaseOf: live });
    ok('the same Skim lands while the game is live', true, true);

    const m2 = await mkt();
    const bet2 = await placeBet({ slug: B, marketId: m2, optionKey: 'home', stakeCents: 2000 });
    const sw = await buyBoost({ slug: A, season: S, kind: 'switcheroo' });
    await rejects('Switcheroo refused when closed', () => switcheroo({ slug: A, boostId: Number(sw.id), betId: Number(bet2.id), phaseOf: closed }), 'game is over');
    await rejects('a bounty cannot be posted on a finished game', () => postBounty({ slug: A, season: S, week: W, target: B, weapon: 'void', betId: Number(bet2.id), phaseOf: closed }), 'game is over');
  }

  console.log('\nno bounty fires on a finished game');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const posted = await postBounty({ slug: A, season: S, week: W, target: B, weapon: 'blind-sabotage', betId: Number(bet.id), phaseOf: open });
    // The game ends while it is filling.
    const state = await contributeToBounty({ slug: 'brandon-lowe', season: S, bountyId: Number(posted.id), points: byKind['blind-sabotage'].cost, phaseOf: closed });
    ok('it refunds instead', state.fired?.refunded, true);
    ok('with the reason', state.fired?.why, 'the game was over before it filled');
    const [n] = await sql`select count(*)::int as n from boosts where target_bet_id = ${Number(bet.id)}`;
    ok('nothing landed on the bet', n.n, 0);
  }

  console.log('\nRide Along only before kickoff');
  {
    const m = await mkt();
    const bet = await placeBet({ slug: B, marketId: m, optionKey: 'home', stakeCents: 2000 });
    const ride = await buyBoost({ slug: A, season: S, kind: 'ride-along' });
    await rejects('refused once the game is live', () => rideAlong({ slug: A, boostId: Number(ride.id), betId: Number(bet.id), phaseOf: live }), 'before the games start');
    await rejects('refused once locked', () => rideAlong({ slug: A, boostId: Number(ride.id), betId: Number(bet.id), phaseOf: async () => 'locked' }), 'before the games start');
    const copy = await rideAlong({ slug: A, boostId: Number(ride.id), betId: Number(bet.id), phaseOf: open });
    ok('allowed before kickoff, at their stake', copy.stakeCents, 2000);
    ok('and at their price', copy.odds, 100);
  }
} finally {
  await clean();
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
