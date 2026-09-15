import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { notify, pushConfigured } from '@/lib/push';

export const dynamic = 'force-dynamic';

/** Sends the signed-in manager a test, so "did it work" has an answer. */
export async function POST() {
  const slug = await currentManager();
  if (!slug) return NextResponse.json({ error: 'Sign in first.' }, { status: 403 });
  if (!pushConfigured()) {
    return NextResponse.json({ error: 'Notifications are not set up on the server.' }, { status: 503 });
  }
  const sent = await notify(slug, {
    title: '🏈 The Book can reach you',
    body: 'This is what an attack, a bounty or a filled order will look like.',
    url: '/book',
    tag: 'test',
  });
  return NextResponse.json({ ok: true, sent });
}
