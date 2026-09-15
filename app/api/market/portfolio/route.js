import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';
import { portfolio } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

/** The signed-in manager's holdings, pending orders and dividends. */
export async function GET() {
  const slug = await currentManager();
  if (!slug || !canSeeMarket(slug)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    return NextResponse.json(await portfolio(slug));
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
