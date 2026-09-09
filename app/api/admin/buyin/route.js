import { NextResponse } from 'next/server';
import { currentBettor } from '@/lib/auth';
import { recordBuyin, markBuyinCollected } from '@/lib/book';

export const dynamic = 'force-dynamic';

// Only the commissioner can approve a re-up or mark cash collected.
const COMMISSIONER = process.env.BOOK_COMMISSIONER ?? 'chris-nicholson';

async function requireCommissioner() {
  const slug = await currentBettor();
  if (slug !== COMMISSIONER) return null;
  return slug;
}

export async function POST(request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: 'Not allowed.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    if (body.action === 'collect') {
      const row = await markBuyinCollected(Number(body.id), body.collected !== false);
      return NextResponse.json({ ok: true, id: String(row.id), collected: row.collected });
    }

    const buyin = await recordBuyin({
      slug: body.slug,
      season: Number(body.season),
      bankrollCents: body.bankrollDollars ? Math.round(Number(body.bankrollDollars) * 100) : undefined,
      amountCents: body.amountDollars ? Math.round(Number(body.amountDollars) * 100) : undefined,
      note: body.note || null,
    });
    return NextResponse.json({ ok: true, id: String(buyin.id) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
