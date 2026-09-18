import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { snapshot } from '@/lib/market/source';
import { ensureRolled } from '@/lib/market/baselines';
import { voidScratchedProps } from '@/lib/scratched';

export const dynamic = 'force-dynamic';

/**
 * The Market's heartbeat. Vercel calls this every minute; a tick is written
 * once a minute while any game is on and once a quarter hour otherwise, so
 * the log has no gaps when everyone is watching the TV instead of the app.
 * Same bearer secret as the weekly cron.
 */
export async function GET(request) {
  const auth = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 401 });
  }
  try {
    const snap = await snapshot();
    // The first tick after Sleeper flips the week rolls the premiums forward.
    const roll = await ensureRolled(snap.season, snap.week).catch((e) => ({ error: e.message }));

    // A prop on a player ruled out has no honest answer -- the over cannot win
    // and the under is free money. Void it here rather than in the weekly cron,
    // because injury news lands on a Friday and the cron runs on a Tuesday.
    const scratched = await voidScratched(snap.season, snap.week).catch((e) => ({ error: e.message }));

    return NextResponse.json({ ...snap, roll, scratched });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}

/**
 * Void any prop whose player has been ruled out, and tell the league when a
 * bet was actually refunded.
 *
 * Silent when nothing is scratched, which is most minutes of most weeks.
 */
async function voidScratched(season, week) {
  const sql = neon(process.env.DATABASE_URL);
  const { settleMarket } = await import('@/lib/book');
  const voided = await voidScratchedProps(season, week, { sql, settleMarket });
  if (!voided.length) return { voided: 0 };

  // Only worth a notification if somebody's money moved. A prop nobody backed
  // disappearing from the board needs no announcement.
  const ids = voided.map((v) => v.id);
  const [{ n } = { n: 0 }] = await sql`
    select count(*)::int as n from bets where market_id = any(${ids}) and status = 'void'`;
  const legs = await sql`
    select count(*)::int as n from parlay_legs where market_id = any(${ids}) and status = 'void'`;
  const touched = Number(n) + Number(legs[0]?.n ?? 0);

  if (touched > 0) {
    const { notifyAll } = await import('@/lib/push');
    const who = voided.map((v) => v.playerName).join(', ');
    await notifyAll({
      title: voided.length === 1 ? `${who} is out — bet voided` : `${voided.length} props voided`,
      body:
        voided.length === 1
          ? `He has been ruled ${voided[0].status.toLowerCase()}. Stakes are back.`
          : `${who} are out. Stakes on those props are back.`,
      url: '/book',
      tag: `scratched-${season}-${week}`,
    }).catch(() => 0);
  }

  return { voided: voided.length, betsRefunded: touched, players: voided.map((v) => v.playerName) };
}
