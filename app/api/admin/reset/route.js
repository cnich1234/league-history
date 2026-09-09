import { NextResponse } from 'next/server';
import { isCommissioner, resetPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Clears someone's password so they can set a new one on next sign-in. */
export async function POST(request) {
  if (!(await isCommissioner())) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }
  const { slug } = await request.json().catch(() => ({}));
  try {
    const row = await resetPassword(slug);
    return NextResponse.json({ ok: true, slug: row.slug, name: row.display_name });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
