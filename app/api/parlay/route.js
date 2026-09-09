import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { placeParlay } from '@/lib/book';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const slug = await currentBettor();
  if (!slug) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const { legs, stakeDollars } = await request.json().catch(() => ({}));

  const dollars = Number(stakeDollars);
  if (!Number.isFinite(dollars)) {
    return NextResponse.json({ error: 'Enter a stake.' }, { status: 400 });
  }

  try {
    const parlay = await placeParlay({
      slug,
      legs: Array.isArray(legs) ? legs : [],
      stakeCents: Math.round(dollars * 100),
    });
    return NextResponse.json({
      ok: true,
      betId: String(parlay.id),
      legs: parlay.legs,
      odds: parlay.combinedOdds,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
