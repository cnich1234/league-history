import { NextResponse } from 'next/server';
import { snapshot } from '@/lib/market/source';
import { ensureRolled } from '@/lib/market/baselines';

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
    const snap = await snapshot();
    // The first tick after Sleeper flips the week rolls the premiums forward.
    const roll = await ensureRolled(snap.season, snap.week).catch((e) => ({ error: e.message }));
    return NextResponse.json({ ...snap, roll });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
