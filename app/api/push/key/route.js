import { NextResponse } from 'next/server';
import { publicKey } from '@/lib/push';

export const dynamic = 'force-dynamic';

/** The public half of the VAPID pair, which a phone needs to subscribe. */
export async function GET() {
  return NextResponse.json({ key: publicKey() });
}
