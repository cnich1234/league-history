import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { saveDraft } from '@/lib/dfs';

export const dynamic = 'force-dynamic';

/**
 * Saves a half-finished lineup.
 *
 * Separate from /api/dfs on purpose: that one creates an ENTRY, which is a
 * commitment -- complete, cap-legal, and in a lobby it charges the buy-in. This
 * just remembers what somebody has picked so far.
 */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot play.' }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    const res = await saveDraft({
      slug,
      contestId: Number(body.contestId),
      slots: body.slots,
    });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
