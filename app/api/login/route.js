import { NextResponse } from 'next/server';
import { authenticate, setSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { slug, password } = await request.json().catch(() => ({}));

  const result = await authenticate(slug, password);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  await setSession(result.slug);
  return NextResponse.json({ slug: result.slug, name: result.name, claimed: result.claimed });
}
