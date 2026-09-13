import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';
import { quotes } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

/** The watchlist, for polling. 404 to anyone off the testers list. */
export async function GET(req) {
  if (!canSeeMarket(await currentBettor())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const source = new URL(req.url).searchParams.get('source');
  try {
    return NextResponse.json(await quotes({ source }));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
