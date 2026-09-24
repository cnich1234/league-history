import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';

export const dynamic = 'force-dynamic';
// Settlement, trophies, daily fantasy and next week's board all share this one
// invocation. At 60 seconds the board build was killed partway through on
// week 3 of 2026; Pro allows 300.
export const maxDuration = 300;

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
    // This used to be `week - 1`, keyed to Sleeper advancing its counter --
    // which it does some hours after the Monday game, at a time of its own
    // choosing. A run just after Monday night could find the counter unmoved,
    // skip every payout, and not try again until the next scheduled run. Now
    // the current week counts as finished once every one of its games is
    // final, so the first run after Monday night settles it. (Before that
    // guard existed at all, `Math.max(1, week - 1)` floored to week 1 and paid
    // out on a week still being played. "No completed week yet" is not week
    // 1, it is nothing, and every step below has to skip rather than guess.)
    const { completedWeek, FIRST_WEEK } = await import('@/lib/cron');
    const priorWeek = await completedWeek(season, week);

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

    // Settle every finished week that is still open, the just-finished one
    // included. Catches up automatically if a run was missed rather than
    // leaving bets pending.
    const { settleWeek } = await import('@/lib/cron');
    for (let w = Math.max(FIRST_WEEK, week - 3); w <= (priorWeek ?? 0); w++) {
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
      if (granted.length) {
        log.push(`granted trophy points to ${granted.length}`);
        // Only on the run that actually paid, so a second run stays quiet.
        try {
          const { notifyAll } = await import('@/lib/push');
          const sent = await notifyAll({
            title: `🏅 Week ${priorWeek} is in the books`,
            body: 'Bets settled, trophies and allowance paid. See what you earned.',
            url: '/trophies',
            tag: `week-${priorWeek}`,
          });
          log.push(`notified ${sent} device(s)`);
        } catch (e) {
          log.push(`notify skipped: ${e.message}`);
        }
      }
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
      // The first ACTUAL kickoff. This used to parse the game date, which gave
      // midnight UTC and locked the contest most of a day early.
      const kicks = Object.values(dates)
        .map((d) => (d?.kickoff instanceof Date ? d.kickoff.getTime() : NaN))
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

    // The MONEY allowance: $500 to bet with, for the week that is opening.
    //
    // Nothing granted this. lib/book.js had the function, tests called it, and
    // the cron called only the POINTS allowance above -- the same mistake that
    // comment describes, made a third time. Weeks 1 and 2 have allowance rows
    // because they were inserted by hand; from week 3 every bet would have
    // failed "Not enough left this week."
    //
    // Credited for the CURRENT week, unlike the points allowance, and before
    // the board is built: it is ammunition for the week ahead, not a reward
    // for one finished, and people need it the moment the markets appear.
    // Idempotent via ledger_allowance_once, so a second run pays nobody twice.
    // Logged even at zero -- a silent step is indistinguishable from one that
    // never ran, which is exactly how this went unnoticed.
    try {
      const { grantWeeklyAllowance: grantMoney, WEEKLY_ALLOWANCE_CENTS } =
        await import('@/lib/book');
      const funded = await grantMoney(week, WEEKLY_ALLOWANCE_CENTS);
      log.push(`money allowance to ${funded.length} for week ${week}`);
    } catch (e) {
      log.push(`money allowance skipped: ${e.message}`);
    }

    // Build the current week's board, or finish one that is half-built.
    //
    // This used to run only when the week had no markets at all, because the
    // builder deduped on title and a title carries the line: a rerun after the
    // lines moved added a second spread beside the first (47 such markets
    // mid-week 1). But the board was also written market by market, and on
    // week 3 of 2026 the run hit its time limit 120 markets in -- before the
    // four specials. The gate then saw "week 3 has markets" on every later
    // run, and the specials never appeared.
    //
    // Both halves are fixed underneath: the board is written in one statement,
    // so a killed run leaves nothing behind, and markets are matched on who and
    // what rather than title (marketIdentity), so a rerun only adds what is
    // missing and never reprices a line someone may have bet. Which makes it
    // safe to run on every scheduled run, each one a chance to repair.
    //
    // Up to the week's first lock, and no further. Early on a Tuesday Sleeper
    // can still report the week that just finished, and filling THAT in would
    // post markets on games already played -- the week 1 mistake again. A week
    // with no markets at all is still built whenever it is found, as before.
    try {
      const [{ n: existing, first_lock: firstLock }] = await sql`
        select count(*)::int as n, min(locks_at) as first_lock
        from markets where season = ${season} and week = ${week}`;
      if (existing > 0 && firstLock && new Date(firstLock) <= new Date()) {
        log.push(`week ${week}: under way, board left alone (${existing} market(s))`);
      } else {
        const { buildWeek } = await import('@/lib/cron');
        const built = await buildWeek(sql, season, week);
        log.push(`week ${week}: ${built.created} market(s) created, ${built.skipped} already there`);
      }
    } catch (e) {
      log.push(`board skipped: ${e.message}`);
    }

    return NextResponse.json({ ok: true, season, week, log });
  } catch (e) {
    // Return the message rather than a bare 500 -- a cron failure is invisible
    // otherwise, and Vercel's log is the only place it would surface.
    return NextResponse.json({ error: e.message, log }, { status: 500 });
  }
}
