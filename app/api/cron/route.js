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
    const { liveMatchups, finishedRostersIn, kickedOffTeams } = await import('@/lib/live');
    try {
      const priorWeek = Math.max(1, week - 1);
      const prior = await liveMatchups(season, priorWeek);
      const locked = await lockDueMarkets(
        finishedRostersIn(prior),
        await kickedOffTeams(season, priorWeek),
        { season, week: priorWeek },
      );
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

    // Score last week's trophies.
    //
    // This never ran here before -- `buildWeek` below is the MARKET builder, a
    // different function with a confusingly similar name. So the cron settled
    // bets and opened the next board while awarding nobody anything, and the
    // Trophy Room would have stayed empty all season.
    try {
      const { buildWeek: scoreWeek } = await import('@/scripts/build-weekly.mjs');
      const { saveWeek, weekPointsBySlug } = await import('@/lib/trophies');
      const { grantTrophyPoints } = await import('@/lib/shop');

      const priorWeek = Math.max(1, week - 1);
      const scored = await scoreWeek(priorWeek);
      await saveWeek(season, scored);
      log.push(`week ${priorWeek}: ${scored.awards.length} award(s)`);

      // Trophy points into the shop. Once-only per week, enforced by an index,
      // so a second cron run cannot inflate anyone.
      const points = await weekPointsBySlug(season, priorWeek);
      const granted = await grantTrophyPoints(season, priorWeek, points);
      if (granted.length) log.push(`granted trophy points to ${granted.length}`);
    } catch (e) {
      log.push(`scoring skipped: ${e.message}`);
    }

    // The SHOP allowance, which is points rather than money. Written, tested,
    // and called by nothing outside its own test since the day it was added --
    // exactly the mistake the comment above describes, made a second time.
    // Without it the only points anybody ever has are the opening balance and
    // whatever trophies pay, and the shop slowly empties.
    //
    // Deliberately OUTSIDE the scoring try: scoring depends on Sleeper having
    // final stats and can reasonably fail, and paying the allowance does not.
    // One should not take the other down.
    //
    // Once-only per (bettor, week), enforced by an index, so a second cron run
    // in the same week cannot double-pay.
    try {
      const { grantWeeklyAllowance } = await import('@/lib/shop');
      const paid = await grantWeeklyAllowance(season, week);
      if (paid.length) log.push(`allowance to ${paid.length} for week ${week}`);
    } catch (e) {
      log.push(`allowance skipped: ${e.message}`);
    }

    // Refund bounties nobody collected. Not forfeit -- nobody did the thing
    // that was asked for, so the points go home.
    try {
      const { expireBounties, cullDeadBountyBets } = await import('@/lib/shop');
      const expired = await expireBounties(season, Math.max(1, week - 1));
      if (expired) log.push(`refunded ${expired} unfilled bounty(s)`);
      // A bounty tied to a bet that has settled can never fire, so it is
      // refunded now rather than holding everyone's points until the week
      // rolls over.
      const dead = await cullDeadBountyBets(season, week);
      if (dead) log.push(`refunded ${dead} bounty(s) whose bet had settled`);
    } catch (e) {
      log.push(`bounty expiry skipped: ${e.message}`);
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
