import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { placeBet } from '@/lib/book';

export const dynamic = 'force-dynamic';

/**
 * Places a bet as the signed-in user.
 *
 * The bettor comes from the signed session cookie, never from the request body.
 * If the client could name the bettor, anyone could bet from someone else's
 * bankroll -- and in a league where the whole point is beating your friends,
 * someone would try.
 */
export async function POST(request) {
  // currentManager, not currentBettor: a guest is signed in but owns no
  // bankroll, so letting one through would try to debit a bettor row that does
  // not exist. Refused here rather than only hidden in the UI.
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot place bets.' }, { status: 403 });
  }

  const { marketId, optionKey, stakeDollars, expectedOdds } = await request.json().catch(() => ({}));

  const dollars = Number(stakeDollars);
  if (!Number.isFinite(dollars)) {
    return NextResponse.json({ error: 'Enter a stake.' }, { status: 400 });
  }
  // Round to cents here so "12.345" cannot reach the integer-cents check and
  // fail with a confusing message.
  const stakeCents = Math.round(dollars * 100);

  try {
    const bet = await placeBet({
      slug,
      marketId: Number(marketId),
      optionKey,
      stakeCents,
      expectedOdds: expectedOdds == null ? null : Number(expectedOdds),
    });
    return NextResponse.json({ ok: true, betId: String(bet.id) });
  } catch (e) {
    // These are all user-facing rule violations, not server faults.
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
