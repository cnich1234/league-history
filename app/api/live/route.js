import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { liveMatchups, finishedRostersIn, kickedOffTeams } from '@/lib/live';
import { lockDueMarkets } from '@/lib/book';

export const dynamic = 'force-dynamic';

export const revalidate = 0;

export async function GET(request) {
  if (!(await currentBettor())) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const week = Number(searchParams.get('week'));
  const season = Number(process.env.BOOK_SEASON ?? 2026);
  if (!week) return NextResponse.json({ error: 'Missing week.' }, { status: 400 });

  try {
    const state = await liveMatchups(season, week);

    // Close what is over, from the state just fetched.
    //
    // Locking used to live in a function nothing called, so no market in the
    // season had ever left 'open'. It belongs here rather than on the weekly
    // cron: a live market has to shut within minutes of its game ending, and
    // Vercel Hobby only allows daily crons. This route already polls every 30s
    // with exactly the data the decision needs.
    //
    // Failing to lock must never fail the response -- the board matters more
    // than the bookkeeping, and the next poll retries in 30 seconds.
    try {
      await lockDueMarkets(finishedRostersIn(state), await kickedOffTeams(season, week), {
        season,
        week,
      });
    } catch {
      // Retried on the next tick.
    }

    return NextResponse.json(state, {
      headers: {
        // Matched to Sleeper's own 60s cache TTL: fetching more often than
        // that returns identical bytes. stale-while-revalidate means a client
        // never waits on the refresh -- it gets the last value instantly while
        // a new one is fetched behind it.
        //
        // The 25s edge cache also bounds how long a finished market stays open,
        // since locking happens on a cache miss. With ten people polling, misses
        // are frequent; the weekly cron is the backstop if nobody is watching,
        // and nothing can be bet at a decided price meanwhile because
        // `shouldSuspend` still governs every quote.
        'Cache-Control': 's-maxage=25, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
