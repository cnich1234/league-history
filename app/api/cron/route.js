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

    // The last week that is actually FINISHED, or null when none is.
    //
    // Sleeper advances `week` once a week's games are done, so `week - 1` is
    // complete -- but only when there IS a previous week. This used to read
    // `Math.max(1, week - 1)`, and during week 1 that floor collapsed to week 1
    // itself: the cron scored trophies, settled daily fantasy and expired
    // bounties against a week still being played, paying out on partial scores.
    // A floor is the wrong shape here. "No completed week yet" is not week 1,
    // it is nothing, and every step below has to skip rather than guess.
    const priorWeek = week > 1 ? week - 1 : null;

    // Backstop for locking, which normally happens on the live poll. If nobody
    // opened the app all weekend, markets would still be 'open' here -- and
    // settlement below only touches markets, not the betting window, so a stale
    // 'open' would keep last week's bets hidden from The Floor.
    const { lockDueMarkets } = await import('@/lib/book');
    const { liveMatchups, finishedRostersIn, kickedOffTeams } = await import('@/lib/live');
    try {
      if (priorWeek == null) throw new Error('no completed week yet');
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

      if (priorWeek == null) throw new Error('no completed week yet');
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
    //
    // Paid for the week that FINISHED, not the one being played. Scores move
    // all through Sunday, so anything keyed to a live week is provisional --
    // and paying on entry to a week meant week 1's allowance landed before a
    // single game was final.
    try {
      if (priorWeek == null) throw new Error('no completed week yet');
      const { grantWeeklyAllowance } = await import('@/lib/shop');
      const paid = await grantWeeklyAllowance(season, priorWeek);
      if (paid.length) log.push(`allowance to ${paid.length} for week ${priorWeek}`);
    } catch (e) {
      log.push(`allowance skipped: ${e.message}`);
    }

    // Daily fantasy, in the order the week actually runs: settle what is
    // finished, then price and open what is next.
    //
    // Each step is its own try. Settling needs Sleeper's final stats and can
    // reasonably fail; pricing next week does not, and one should not take the
    // other down -- the same reason the allowance sits outside the scoring try
    // above.
    try {
      const { settleWeek } = await import('@/lib/dfs');
      if (priorWeek == null) throw new Error('no completed week yet');
      const prior = priorWeek;
      const { lockDueContests } = await import('@/lib/dfs');
      // Lock what can no longer be edited and refund lobbies that never
      // filled, THEN settle -- settleWeek only touches locked contests, so
      // without this nothing would ever become settleable.
      const swept = await lockDueContests(season, prior);
      if (swept.locked || swept.voided) {
        log.push(`daily: locked ${swept.locked}, voided ${swept.voided}`);
      }
      const done = await settleWeek(season, prior);
      log.push(`daily: settled ${done.contests} contest(s) for week ${prior}`);
    } catch (e) {
      log.push(`daily settle skipped: ${e.message}`);
    }

    try {
      const { buildSalaries, weeklyContest } = await import('@/lib/dfs');
      const { teamGameDates } = await import('@/lib/schedule');

      // Salaries refresh weekly, from that week's own projections, and
      // buildSalaries fetches them itself -- Sleeper's projection rows carry
      // name, position and team, so this needs no player file. The full one is
      // 15MB and cannot ship in a serverless bundle; the slim stand-in holds
      // only rostered players and no team at all.
      //
      // Frozen once written, so a second run in the same week changes no price
      // somebody has already drafted against.
      // Defence rankings for the player cards. A separate try inside the same
      // block: a missing or rate-limited FantasyPros key must not stop
      // salaries being priced, and a pool with no matchup line is still a
      // playable pool -- the card just omits it.
      try {
        const { buildDefenseRanks } = await import('@/lib/dfs');
        // FantasyPros only publishes rankings for the CURRENT week -- asking
        // for a future one returns an empty list. So this fetches whatever is
        // available now and simply keeps what earlier weeks already have.
        const d = await buildDefenseRanks(season, week);
        log.push(`daily: ranked ${d.written} defence(s) for week ${week}`);
      } catch (e) {
        // Not a failure worth stopping for: a pool with no matchup line is
        // still playable, the card just omits it.
        log.push(`defence ranks skipped: ${e.message}`);
      }

      const built = await buildSalaries(season, week);
      // Logged even at zero: a silent step is indistinguishable from a step
      // that never ran, which is exactly how the allowance went unnoticed for
      // weeks. Zero here means the week was already priced, which is correct.
      log.push(`daily: priced ${built.written} of ${built.priced} for week ${week}`);

      // The weekly contest, created on demand and locking at the first kickoff
      // of the week so the board has a deadline to show.
      const dates = await teamGameDates(season, week).catch(() => ({}));
      const kicks = Object.values(dates)
        .map((d) => new Date(d).getTime())
        .filter(Number.isFinite);
      const first = kicks.length ? new Date(Math.min(...kicks)) : null;
      await weeklyContest(season, week, first);
    } catch (e) {
      log.push(`daily salaries skipped: ${e.message}`);
    }

    // Refund bounties nobody collected. Not forfeit -- nobody did the thing
    // that was asked for, so the points go home.
    //
    // Two different questions, so two separate steps. Expiry asks whether a
    // WEEK is over; culling asks whether a BET has settled, which happens all
    // through a live week. Guarding both on priorWeek would hold people's
    // points on dead bounties for the whole of week 1.
    try {
      if (priorWeek == null) throw new Error('no completed week yet');
      const { expireBounties } = await import('@/lib/shop');
      const expired = await expireBounties(season, priorWeek);
      if (expired) log.push(`refunded ${expired} unfilled bounty(s)`);
    } catch (e) {
      log.push(`bounty expiry skipped: ${e.message}`);
    }

    // A bounty tied to a bet that has settled can never fire, so it is
    // refunded now rather than holding everyone's points until the week rolls
    // over. This is about the CURRENT week and runs whether or not any week
    // has finished.
    try {
      const { cullDeadBountyBets } = await import('@/lib/shop');
      const dead = await cullDeadBountyBets(season, week);
      if (dead) log.push(`refunded ${dead} bounty(s) whose bet had settled`);
    } catch (e) {
      log.push(`bounty cull skipped: ${e.message}`);
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
