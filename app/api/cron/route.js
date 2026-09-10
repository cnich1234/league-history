import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Weekly upkeep, run by Vercel Cron so nothing has to happen by hand.
 *
 * Two jobs, both idempotent:
 *   - settle    resolve last week's markets from Sleeper's final scores
 *   - markets   build the coming week's board
 *
 * Order matters. Settling first means a manager's payout is back in their
 * bankroll before the new board opens, so they are not blocked from betting by
 * money they have already won.
 *
 * Vercel Cron requests carry a bearer token that only Vercel knows. Without
 * checking it, anyone who found this URL could trigger a settlement.
 */
export async function GET(request) {
  const auth = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 401 });
  }

  const sql = neon(process.env.DATABASE_URL);
  const log = [];

  try {
    const state = await fetch('https://api.sleeper.app/v1/state/nfl').then((r) => r.json());
    const season = Number(state.season);
    const week = Number(state.week);

    // Backstop for locking, which normally happens on the live poll. If nobody
    // opened the app all weekend, markets would still be 'open' here -- and
    // settlement below only touches markets, not the betting window, so a stale
    // 'open' would keep last week's bets hidden from The Floor.
    const { lockDueMarkets } = await import('@/lib/book');
    const { liveMatchups, finishedRostersIn } = await import('@/lib/live');
    try {
      const prior = await liveMatchups(season, Math.max(1, week - 1));
      const locked = await lockDueMarkets(finishedRostersIn(prior));
      if (locked.length) log.push(`locked ${locked.length} market(s)`);
    } catch (e) {
      log.push(`lock skipped: ${e.message}`);
    }

    // Settle everything before the current week that is still open. Catches up
    // automatically if a run was missed rather than leaving bets pending.
    const { settleWeek } = await import('@/lib/cron');
    for (let w = Math.max(1, week - 3); w < week; w++) {
      const result = await settleWeek(sql, season, w);
      if (result.settled || result.voided) {
        log.push(`week ${w}: settled ${result.settled}, voided ${result.voided}`);
      }
    }

    // Build the current week's board if it does not exist yet.
    const { buildWeek } = await import('@/lib/cron');
    const built = await buildWeek(sql, season, week);
    log.push(`week ${week}: ${built.created} market(s) created, ${built.skipped} existing`);

    return NextResponse.json({ ok: true, season, week, log });
  } catch (e) {
    // Return the message rather than a bare 500 -- a cron failure is invisible
    // otherwise, and Vercel's log is the only place it would surface.
    return NextResponse.json({ error: e.message, log }, { status: 500 });
  }
}
