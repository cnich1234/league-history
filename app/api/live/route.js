import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { liveMatchups } from '@/lib/live';

export const dynamic = 'force-dynamic';

// Cached briefly so ten people polling every 30s do not become ten Sleeper
// requests every 30s. Stale-while-revalidate keeps a response instant while a
// fresh one is fetched behind it.
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
      headers: { 'Cache-Control': 's-maxage=20, stale-while-revalidate=40' },
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
