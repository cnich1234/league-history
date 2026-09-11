import { neon } from '@neondatabase/serverless';
import { testWeek, fundWeek, unfundWeek } from './test-helpers.mjs';
import { placeBet, settleMarket, weeklyBalance } from '../lib/book.js';
import { buyBoost, undoBet } from '../lib/shop.js';
const sql = neon(process.env.DATABASE_URL);
const S = 9986, W = testWeek(S), A = 'chris-nicholson', B = 'devin-nicholson';
let failed = 0;
const ok=(l,a,e)=>{const m=JSON.stringify(a)===JSON.stringify(e);
  console.log(`  ${m?'ok  ':'FAIL'} ${l}${m?'':` (want ${JSON.stringify(e)}, got ${JSON.stringify(a)})`}`);if(!m)failed++;};
const bank=async s=>Number((await sql`select bank_cents from banks where slug=${s}`)[0]?.bank_cents??0);

async function mkt({live=false, locked=false}={}) {
  const [m]=await sql`insert into markets (season,week,kind,title,locks_at,status,live,meta)
    values (${S},${W},'h2h',${'U '+Math.random()},
            ${locked?new Date(Date.now()-3600e3):new Date(Date.now()+86400e3)},'open',${live},'{}'::jsonb) returning id`;
  await sql`insert into market_options (market_id,option_key,label,odds)
    values (${m.id},'home','Home',200),(${m.id},'away','Away',200)`;
  return Number(m.id);
}
async function clean(){
  const ids=(await sql`select id from markets where season=${S}`).map(r=>r.id);
  const bids=ids.length?(await sql`select id from bets where market_id=any(${ids})`).map(r=>r.id):[];
  if(bids.length){await sql`delete from boosts where target_bet_id=any(${bids})`;await sql`delete from parlay_legs where bet_id=any(${bids})`;await sql`delete from ledger where bet_id=any(${bids})`;await sql`delete from bets where id=any(${bids})`;}
  if(ids.length){await sql`delete from market_options where market_id=any(${ids})`;await sql`delete from markets where id=any(${ids})`;}
  await sql`delete from boosts where season=${S}`;await sql`delete from point_ledger where season=${S}`;await unfundWeek(W);
}
await clean(); await fundWeek(W);
try {
  await sql`insert into point_ledger (bettor,season,amount,reason,note) values (${A},${S},300,'adjustment','t')`;

  console.log('\nundoing a pending bet');
  const m1 = await mkt();
  const before = await weeklyBalance(A, W);
  const bet = await placeBet({ slug:A, marketId:m1, optionKey:'home', stakeCents:20000 });
  ok('the stake left the week', (await weeklyBalance(A,W)) - before, -20000);
  const u1 = await buyBoost({ slug:A, season:S, kind:'undo' });
  const res = await undoBet({ slug:A, boostId:Number(u1.id), betId:Number(bet.id) });
  ok('the whole stake came back', res.refundedCents, 20000);
  ok('and the week is whole', await weeklyBalance(A,W), before);
  const [v] = await sql`select status from bets where id=${bet.id}`;
  ok('the bet is void', v.status, 'void');

  console.log('\nundoing a LIVE bet');
  // Placed while still pregame, then the market goes live -- a synthetic live
  // market has no real game behind it, so live PRICING would suspend. Undo does
  // not price anything, which is exactly the point being tested.
  const m2 = await mkt({ live:true });
  const live = await placeBet({ slug:A, marketId:m2, optionKey:'home', stakeCents:15000 });
  await sql`update markets set locks_at = now() - interval '1 hour' where id = ${m2}`;
  const u2 = await buyBoost({ slug:A, season:S, kind:'undo' });
  const r2 = await undoBet({ slug:A, boostId:Number(u2.id), betId:Number(live.id) });
  ok('works mid-game too', r2.refundedCents, 15000);

  console.log('\nwhat it will not do');
  const m3 = await mkt();
  const theirs = await placeBet({ slug:B, marketId:m3, optionKey:'home', stakeCents:5000 });
  const u3 = await buyBoost({ slug:A, season:S, kind:'undo' });
  try { await undoBet({ slug:A, boostId:Number(u3.id), betId:Number(theirs.id) }); ok('refused on someone else', false, true); }
  catch(e){ ok('refused on someone else', e.message.includes('your own bet'), true); }

  const m4 = await mkt();
  const done = await placeBet({ slug:A, marketId:m4, optionKey:'home', stakeCents:5000 });
  await settleMarket(m4, 'home');
  try { await undoBet({ slug:A, boostId:Number(u3.id), betId:Number(done.id) }); ok('refused once settled', false, true); }
  catch(e){ ok('refused once settled', e.message.includes('already settled'), true); }

  console.log('\nan undone bet pays nobody');
  const bankBefore = await bank(A);
  const m5 = await mkt();
  const doomed = await placeBet({ slug:A, marketId:m5, optionKey:'home', stakeCents:10000 });
  const u5 = await buyBoost({ slug:A, season:S, kind:'undo' });
  await undoBet({ slug:A, boostId:Number(u5.id), betId:Number(doomed.id) });
  await settleMarket(m5, 'home');  // the side they had backed WINS
  ok('no winnings from a voided bet', await bank(A), bankBefore);
} finally { await clean(); }
console.log(failed?`\n${failed} FAILED\n`:'\nall checks passed\n');
process.exit(failed?1:0);
