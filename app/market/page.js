import { currentManager } from '@/lib/auth';
import { quotes, normaliseSource } from '@/lib/market/source';
import MarketList from '@/components/market/MarketList';

export const metadata = { title: 'The Market' };
export const dynamic = 'force-dynamic';

/**
 * The watchlist: every stock, its price, how it has moved, and how many you
 * own. `?source=mock` swaps the real prices for the invented ones.
 */
export default async function MarketPage({ searchParams }) {
  const sp = await searchParams;
  const source = normaliseSource(sp?.source);
  const owner = await currentManager();
  const initial = await quotes({ source, owner }).catch((e) => ({
    source,
    asOf: Date.now(),
    rows: [],
    error: e.message,
  }));
  return <MarketList initial={initial} source={source} />;
}
