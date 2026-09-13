import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';
import { explain } from '@/lib/market/source';
import { trackCsv } from '@/lib/market/why';

export const dynamic = 'force-dynamic';

/**
 * Why a stock moved: ?ticker=BROB&range=1D, add &format=csv for the raw
 * track as a spreadsheet.
 */
export async function GET(req) {
  if (!canSeeMarket(await currentBettor())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const sp = new URL(req.url).searchParams;
  try {
    const data = await explain({ ticker: sp.get('ticker'), range: sp.get('range') ?? undefined });
    if (!data) return NextResponse.json({ error: 'No such stock' }, { status: 404 });
    if (sp.get('format') === 'csv') {
      return new NextResponse(trackCsv(data.track), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${data.player.ticker}-${data.range}.csv"`,
        },
      });
    }
    return NextResponse.json({ player: data.player, range: data.range, moves: data.moves, ticks: data.track.length });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
