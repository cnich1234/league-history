import { notFound } from 'next/navigation';
import { history, normaliseSource } from '@/lib/market/source';
import { DEFAULT_RANGE, RANGES } from '@/lib/market/candles';
import StockChart from '@/components/market/StockChart';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { ticker } = await params;
  return { title: `${String(ticker).toUpperCase()} · The Market` };
}

/** One stock: the header, the chart, the range tabs. */
export default async function StockPage({ params, searchParams }) {
  const { ticker } = await params;
  const sp = await searchParams;
  const source = normaliseSource(sp?.source);
  const range = RANGES[sp?.range] ? sp.range : DEFAULT_RANGE;
  const initial = await history({ source, ticker, range }).catch(() => null);
  if (!initial) notFound();
  return <StockChart initial={initial} source={source} />;
}
