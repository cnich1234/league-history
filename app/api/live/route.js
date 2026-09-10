import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { liveMatchups } from '@/lib/live';

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
    return NextResponse.json(state, {
      headers: {
        // Matched to Sleeper's own 60s cache TTL: fetching more often than
        // that returns identical bytes. stale-while-revalidate means a client
        // never waits on the refresh -- it gets the last value instantly while
        // a new one is fetched behind it.
        'Cache-Control': 's-maxage=25, stale-while-revalidate=60',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
