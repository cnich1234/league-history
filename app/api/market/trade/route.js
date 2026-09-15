import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import { canTrade } from '@/lib/market/access';
import { quotes, fillNow } from '@/lib/market/source';
import { placeOrder, cancelOrder } from '@/lib/market/trading';

export const dynamic = 'force-dynamic';

/**
 * Place or cancel an order.
 *   { ticker, side: 'buy' | 'sell', shares }   queues an order for the next tick
 *   { cancel: orderId }                         cancels one still pending
 * Managers only: a guest can look but never own anything.
 */
export async function POST(req) {
  const slug = await currentManager();
  if (!slug || !canTrade(slug)) {
    return NextResponse.json({ error: 'Trading is not open to you yet.' }, { status: 403 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  }
  try {
    if (body?.cancel != null) {
      const row = await cancelOrder({ owner: slug, orderId: Number(body.cancel) });
      return NextResponse.json({ ok: true, cancelled: row.id });
    }
    const board = await quotes({ source: 'live' });
    const sym = String(body?.ticker ?? '').toUpperCase();
    const player = board.rows.find((r) => r.ticker === sym);
    if (!player) return NextResponse.json({ error: 'No such stock.' }, { status: 404 });
    const order = await placeOrder({
      owner: slug,
      season: board.season,
      week: board.week,
      playerId: player.id,
      side: body?.side,
      shares: Number(body?.shares),
      price: player.price,
    });
    // Try to fill straight away. If the last tick is under a minute old the
    // order waits for the cron's next one, which is the point of the rule.
    const attempt = await fillNow().catch(() => null);
    return NextResponse.json({ ok: true, order, price: player.price, filled: Boolean(attempt?.fills?.filled) });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
