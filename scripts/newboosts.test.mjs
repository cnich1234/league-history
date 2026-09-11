import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, settleMarket } from '../lib/book.js';
import { buyBoost, rideAlong, curseWeek, boostsForBets } from '../lib/shop.js';
import { applyBoosts } from '../lib/boosts.js';
import { payoutCents } from '../lib/odds.js';

const sql = neon(process.env.DATABASE_URL);
const S = 9988, W = testWeek(S);
const A = 'chris-nicholson', B = 'devin-nicholson';
let failed = 0;
const ok = (l, a, e) => {
  const m = JSON.stringify(a) === JSON.stringify(e);
  console.log(`  ${m ? 'ok  ' : 'FAIL'} ${l}${m ? '' : ` (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`}`);
  if (!m) failed++;
};
const bank = async (s) => Number((await sql`select bank_cents from banks where slug=${s}`)[0]?.bank_cents ?? 0);

async function mkt(odds = 200) {
  const [m] = await sql`insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S}, ${W}, 'h2h', ${'NB ' + Math.random()}, ${new Date(Date.now()+86400e3)}, 'open', false, '{}'::jsonb) returning id`;
  await sql`insert into market_options (market_id, option_key, label, odds)
    values (${m.id}, 'home', 'Home', ${odds}), (${m.id}, 'away', 'Away', ${odds})`;
  return Number(m.id);
}
async function pts(s, n) {
  await sql`insert into point_ledger (bettor, season, amount, reason, note) values (${s}, ${S}, ${n}, 'adjustment', 't')`;
}
async function clean() {
  const ids = (await sql`select id from markets where season=${S}`).map(r=>r.id);
  const bids = ids.length ? (await sql`select id from bets where market_id=any(${ids})`).map(r=>r.id) : [];
  if (bids.length) { await sql`delete from boosts where target_bet_id=any(${bids})`; await sql`delete from ledger where bet_id=any(${bids})`; await sql`delete from bets where id=any(${bids})`; }
  if (ids.length) { await sql`delete from market_options where market_id=any(${ids})`; await sql`delete from markets where id=any(${ids})`; }
  await sql`delete from boosts where season=${S}`;
  await sql`delete from point_ledger where season=${S}`;
  await unfundWeek(W);
}

await clean(); await fundWeek(W);
try {
  console.log('\nRide Along copies a bet blind');
  await pts(A, 300);
  const m1 = await mkt(300);
  const theirs = await placeBet({ slug: B, marketId: m1, optionKey: 'home', stakeCents: 10000 });
  const ride = await buyBoost({ slug: A, season: S, kind: 'ride-along' });
  const copy = await rideAlong({ slug: A, boostId: Number(ride.id), betId: Number(theirs.id) });

  ok('same stake', copy.stakeCents, 10000);
  ok('same price', copy.odds, 300);
  const [orig] = await sql`select stake_cents, status from bets where id=${theirs.id}`;
  ok('the original is untouched', Number(orig.stake_cents), 10000);

  const aBefore = await bank(A), bBefore = await bank(B);
  await settleMarket(m1, 'home');
  const profit = payoutCents(10000, 300) - 10000;
  ok('both win together', [(await bank(A)) - aBefore, (await bank(B)) - bBefore], [profit, profit]);

  console.log('\nyou cannot ride your own bet');
  const m2 = await mkt();
  const mine = await placeBet({ slug: A, marketId: m2, optionKey: 'home', stakeCents: 5000 });
  const r2 = await buyBoost({ slug: A, season: S, kind: 'ride-along' });
  try { await rideAlong({ slug: A, boostId: Number(r2.id), betId: Number(mine.id) }); ok('refused', false, true); }
  catch (e) { ok('refused', e.message.includes('already your bet'), true); }

  console.log('\nthe curse hits a whole week');
  await pts(B, 300);
  const m3 = await mkt(200), m4 = await mkt(200);
  const b1 = await placeBet({ slug: B, marketId: m3, optionKey: 'home', stakeCents: 8000 });
  const b2 = await placeBet({ slug: B, marketId: m4, optionKey: 'home', stakeCents: 6000 });
  const curse = await buyBoost({ slug: A, season: S, kind: 'week-curse' });
  await curseWeek({ slug: A, boostId: Number(curse.id), target: B, week: W });

  const held = await boostsForBets([Number(b1.id), Number(b2.id)]);
  ok('both their bets are cursed', [held[b1.id], held[b2.id]], [['week-curse'], ['week-curse']]);

  const before = await bank(B);
  await settleMarket(m3, 'home');
  await settleMarket(m4, 'home');
  const expected = (applyBoosts(payoutCents(8000,200), ['week-curse']) - 8000)
                 + (applyBoosts(payoutCents(6000,200), ['week-curse']) - 6000);
  ok('both payouts cut 30%', (await bank(B)) - before, expected);

  console.log('\nyou cannot curse yourself');
  const c2 = await buyBoost({ slug: A, season: S, kind: 'week-curse' });
  try { await curseWeek({ slug: A, boostId: Number(c2.id), target: A, week: W }); ok('refused', false, true); }
  catch (e) { ok('refused', e.message.includes('someone else'), true); }
} finally { await clean(); }
console.log(failed ? `\n${failed} FAILED\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
