import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { placeParlay } from '@/lib/book';
import { useBoostOnBet } from '@/lib/shop';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  // currentManager, not currentBettor: a guest is signed in but owns no
  // bankroll, so letting one through would try to debit a bettor row that does
  // not exist. Refused here rather than only hidden in the UI.
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot place bets.' }, { status: 403 });
  }

  const { legs, stakeDollars, attachBoostIds } = await request.json().catch(() => ({}));

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
    // Insurance, Half Again and Mirror, chosen in the slip and attached the
    // moment the parlay exists -- the only moment they can be.
    const attached = [];
    for (const id of Array.isArray(attachBoostIds) ? attachBoostIds : []) {
      try {
        await useBoostOnBet({ slug, boostId: Number(id), betId: Number(parlay.id), atPlacement: true });
        attached.push(String(id));
      } catch {
        // The parlay is placed and paid for; a boost that will not attach
        // stays in the inventory rather than failing the bet.
      }
    }
    return NextResponse.json({
      ok: true,
      betId: String(parlay.id),
      legs: parlay.legs,
      odds: parlay.combinedOdds,
      attached,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
