import { NextResponse } from 'next/server';
import { snapshot } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

/**
 * The Market's heartbeat. Vercel calls this every minute; a tick is written
 * once a minute while any game is on and once a quarter hour otherwise, so
 * the log has no gaps when everyone is watching the TV instead of the app.
 * Same bearer secret as the weekly cron.
 */
export async function GET(request) {
  const auth = request.headers.get('authorization');
  const expected = process.env.CRON_SECRET;
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 401 });
  }
  try {
    return NextResponse.json(await snapshot());
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
