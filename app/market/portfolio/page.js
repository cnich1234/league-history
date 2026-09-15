import { notFound } from 'next/navigation';
import { currentManager } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';
import { portfolio } from '@/lib/market/source';
import Portfolio from '@/components/market/Portfolio';

export const metadata = { title: 'My Portfolio · The Market' };
export const dynamic = 'force-dynamic';

/** What the signed-in manager owns. Guests have nothing to own. */
export default async function PortfolioPage() {
  const slug = await currentManager();
  if (!slug || !canSeeMarket(slug)) notFound();
  const initial = await portfolio(slug).catch(() => null);
  if (!initial) {
    return (
      <section className="section">
        <div className="empty">Could not load your portfolio just now.</div>
      </section>
    );
  }
  return <Portfolio initial={initial} />;
}
