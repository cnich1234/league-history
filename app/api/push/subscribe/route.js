import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { saveSubscription, removeSubscription } from '@/lib/push';

export const dynamic = 'force-dynamic';

/** Registers this phone for the signed-in manager. Guests have nothing to be told. */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) return NextResponse.json({ error: 'Sign in first.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try {
    await saveSubscription(slug, body.subscription, body.userAgent ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function DELETE(request) {
  const slug = await currentManager();
  if (!slug) return NextResponse.json({ error: 'Sign in first.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const removed = await removeSubscription(slug, String(body.endpoint ?? '')).catch(() => 0);
  return NextResponse.json({ ok: true, removed });
}
