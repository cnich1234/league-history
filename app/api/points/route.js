import { NextResponse } from 'next/server';
import { getPointBalances } from '@/lib/shop';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Everyone's spendable point balance.
 *
 * Public, and deliberately so: the points table is already on the Store tab for
 * anyone signed in, and a balance reveals nothing about what someone bet -- only
 * what they can afford. It is the one number the Trophy Room cannot compute for
 * itself, since that page prerenders and these change whenever anyone buys.
 *
 * Spendable, not earned. A manager who has bought a boost shows less than they
 * have won, which is the point of displaying it.
 */
export async function GET() {
  try {
    const rows = await getPointBalances(SEASON);
    return NextResponse.json({
      season: SEASON,
      balances: rows.map((r) => ({
        slug: r.slug,
        name: r.display_name,
        points: Number(r.points),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
