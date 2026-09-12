import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { enterContest, salaryPool } from '@/lib/dfs';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * The player pool for a week.
 *
 * Served to the builder in one go rather than searched server-side: a week is
 * about 450 rows, which is small enough to filter in the browser and means
 * typing in the search box costs no round trips.
 */
export async function GET(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Sign in to play.' }, { status: 403 });
  }
  const { searchParams } = new URL(request.url);
  const week = Number(searchParams.get('week') ?? 1);
  const pool = await salaryPool(SEASON, week);
  return NextResponse.json({ ok: true, week, pool });
}

/**
 * Saves a lineup.
 *
 * Every rule the builder enforces is re-checked here against the database --
 * shape, cap, duplicates, the pool itself -- because a component is a
 * suggestion and this one decides where points go.
 */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot enter.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  try {
    const res = await enterContest({
      slug,
      contestId: Number(body.contestId),
      slots: body.slots,
      season: SEASON,
      week: body.week == null ? undefined : Number(body.week),
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
