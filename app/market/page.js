import { quotes, normaliseSource } from '@/lib/market/source';
import MarketList from '@/components/market/MarketList';

export const metadata = { title: 'The Market' };
export const dynamic = 'force-dynamic';

/**
 * The watchlist: every stock, its price, and how it has moved today.
 * `?source=live` swaps the invented prices for the real feed.
 */
export default async function MarketPage({ searchParams }) {
  const sp = await searchParams;
  const source = normaliseSource(sp?.source);
  const initial = await quotes({ source }).catch((e) => ({
    source,
    asOf: Date.now(),
    rows: [],
    error: e.message,
  }));
  return <MarketList initial={initial} source={source} />;
}
