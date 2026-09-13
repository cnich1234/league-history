import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';

export const dynamic = 'force-dynamic';

/** Does the nav get a Market tab? Cookie check only, no database. */
export async function GET() {
  const slug = await currentBettor();
  return NextResponse.json({ ok: canSeeMarket(slug) });
}
