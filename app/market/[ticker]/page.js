import { notFound } from 'next/navigation';
import { currentManager } from '@/lib/auth';
import { canTrade } from '@/lib/market/access';
import { history, normaliseSource } from '@/lib/market/source';
import { DEFAULT_RANGE, RANGES } from '@/lib/market/candles';
import StockChart from '@/components/market/StockChart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { ticker } = await params;
  return { title: `${String(ticker).toUpperCase()} · The Market` };
}

/** One stock: the header, the chart, the range tabs, and the trade sheet. */
export default async function StockPage({ params, searchParams }) {
  const { ticker } = await params;
  const sp = await searchParams;
  const source = normaliseSource(sp?.source);
  const range = RANGES[sp?.range] ? sp.range : DEFAULT_RANGE;
  // The layout has already turned away anyone who cannot see the Market; a
  // guest gets here with no manager slug and simply cannot trade.
  const owner = await currentManager();
  const initial = await history({ source, ticker, range, owner }).catch(() => null);
  if (!initial) notFound();
  return <StockChart initial={initial} source={source} canTrade={canTrade(owner)} />;
}
