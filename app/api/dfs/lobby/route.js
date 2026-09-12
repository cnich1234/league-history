import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { openLobby } from '@/lib/dfs';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Opens a lobby.
 *
 * Seats and buy-in are checked in lib/dfs.js against the database, not here:
 * the host has to be able to cover the buy-in, and a lobby of one is not a
 * contest.
 */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot open lobbies.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  try {
    const lobby = await openLobby({
      slug,
      season: SEASON,
      week: Number(body.week ?? 1),
      name: body.name,
      seats: body.seats,
      buyinPoints: body.buyinPoints,
    });
    return NextResponse.json({ ok: true, id: String(lobby.id) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
