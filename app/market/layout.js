import './market.css';
import { notFound } from 'next/navigation';
import { currentBettor } from '@/lib/auth';
import { canSeeMarket } from '@/lib/market/access';

export const dynamic = 'force-dynamic';

/**
 * The Market's front door. Anyone not on the testers list gets a 404, so the
 * feature does not exist for them rather than being a locked door they can
 * see. The stylesheet is scoped to this branch of the app by living here.
 */
export default async function MarketLayout({ children }) {
  const slug = await currentBettor();
  if (!canSeeMarket(slug)) notFound();
  return <div className="mk">{children}</div>;
}
