import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet } from '../lib/book.js';
import { buyBoost, availableOddsBoosts } from '../lib/shop.js';
import { boostOdds } from '../lib/boosts.js';
const sql = neon(process.env.DATABASE_URL);
const S = 9987, W = testWeek(S), A = 'chris-nicholson';
let failed = 0;
const ok = (l,a,e) => { const m = JSON.stringify(a)===JSON.stringify(e);
  console.log(`  ${m?'ok  ':'FAIL'} ${l}${m?'':` (want ${JSON.stringify(e)}, got ${JSON.stringify(a)})`}`); if(!m) failed++; };

async function mkt(odds=200) {
  const [m] = await sql`insert into markets (season, week, kind, title, locks_at, status, live, meta)
    values (${S},${W},'h2h',${'BP '+Math.random()},${new Date(Date.now()+86400e3)},'open',false,'{}'::jsonb) returning id`;
  await sql`insert into market_options (market_id, option_key, label, odds)
    values (${m.id},'home','Home',${odds}),(${m.id},'away','Away',${odds})`;
  return Number(m.id);
}
async function clean() {
  const ids=(await sql`select id from markets where season=${S}`).map(r=>r.id);
  const bids=ids.length?(await sql`select id from bets where market_id=any(${ids})`).map(r=>r.id):[];
  if(bids.length){await sql`delete from boosts where target_bet_id=any(${bids})`;await sql`delete from ledger where bet_id=any(${bids})`;await sql`delete from bets where id=any(${bids})`;}
  if(ids.length){await sql`delete from market_options where market_id=any(${ids})`;await sql`delete from markets where id=any(${ids})`;}
  await sql`delete from boosts where season=${S}`; await sql`delete from point_ledger where season=${S}`; await unfundWeek(W);
}
await clean(); await fundWeek(W);
try {
  await sql`insert into point_ledger (bettor, season, amount, reason, note) values (${A},${S},100,'adjustment','t')`;
  const b = await buyBoost({ slug: A, season: S, kind: 'odds-boost' });

  ok('offered in the slip', (await availableOddsBoosts(A, S)).length, 1);

  console.log('\nnot used unless chosen');
  const m1 = await mkt(200);
  const plain = await placeBet({ slug: A, marketId: m1, optionKey: 'home', stakeCents: 5000 });
  ok('price unchanged', plain.odds, 200);
  ok('and the boost survives', (await availableOddsBoosts(A, S)).length, 1);

  console.log('\nused when chosen');
  const m2 = await mkt(200);
  const boosted = await placeBet({ slug: A, marketId: m2, optionKey: 'home', stakeCents: 5000, oddsBoostId: b.id });
  ok('price improved', boosted.odds, boostOdds(200));
  ok('and the boost is spent', (await availableOddsBoosts(A, S)).length, 0);

  console.log('\ncannot be spent twice');
  const m3 = await mkt(200);
  try { await placeBet({ slug: A, marketId: m3, optionKey: 'home', stakeCents: 5000, oddsBoostId: b.id }); ok('refused', false, true); }
  catch(e){ ok('refused', e.message.includes('already been used'), true); }

  console.log('\ncannot spend someone else’s');
  const b2 = await buyBoost({ slug: A, season: S, kind: 'odds-boost' });
  const m4 = await mkt(200);
  try { await placeBet({ slug: 'devin-nicholson', marketId: m4, optionKey: 'home', stakeCents: 5000, oddsBoostId: b2.id }); ok('refused', false, true); }
  catch(e){ ok('refused', e.message.includes('not yours'), true); }
} finally { await clean(); }
console.log(failed?`\n${failed} FAILED\n`:'\nall checks passed\n');
process.exit(failed?1:0);
