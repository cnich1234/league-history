import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { postBounty } from '@/lib/shop';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Posts a bounty.
 *
 * currentManager, not currentBettor: a guest owns no points and cannot put any
 * on somebody's head. Every other rule -- can you afford it, is that a real
 * attack, is there already one on them -- is enforced in lib/shop.js against
 * the database.
 */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot post bounties.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  try {
    const bounty = await postBounty({
      slug,
      season: SEASON,
      week: Number(body.week ?? process.env.BOOK_WEEK ?? 1),
      target: String(body.target ?? ''),
      weapon: String(body.weapon ?? ''),
      rewardPoints: body.rewardPoints,
    });
    return NextResponse.json({ ok: true, bounty });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
