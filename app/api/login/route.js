import { NextResponse } from 'next/server';
import { checkPassword, setSession } from '@/lib/auth';
import { getBankrolls } from '@/lib/book';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { slug, password } = await request.json().catch(() => ({}));

  if (!checkPassword(password)) {
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }

  // The slug must be a real bettor. Without this check a signed cookie could be
  // minted for any string, and the ledger would grow rows for people who do not
  // exist.
  const bettors = await getBankrolls();
  const match = bettors.find((b) => b.slug === slug);
  if (!match) {
    return NextResponse.json({ error: 'Pick who you are.' }, { status: 400 });
  }

  await setSession(slug);
  return NextResponse.json({ slug, name: match.display_name });
}
