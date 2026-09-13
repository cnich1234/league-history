import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';
import { history } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

/** One stock's quote and candles: ?ticker=BROB&range=1W&source=mock */
export async function GET(req) {
  if (!canSeeMarket(await currentBettor())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const sp = new URL(req.url).searchParams;
  try {
    const data = await history({
      source: sp.get('source'),
      ticker: sp.get('ticker'),
      range: sp.get('range') ?? undefined,
    });
    if (!data) return NextResponse.json({ error: 'No such stock' }, { status: 404 });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
