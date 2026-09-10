import { isCommissioner, listBettors } from '@/lib/auth';
import { getBankrolls, getBuyins, getPrizePool } from '@/lib/book';
import AdminPanel from '@/components/AdminPanel';

export const metadata = { title: 'Commissioner' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export default async function AdminPage() {
  if (!(await isCommissioner())) {
    return (
      <section className="section">
        <div className="empty">Not your table.</div>
      </section>
    );
  }

  const [roster, bankrolls, buyins, pool] = await Promise.all([
    listBettors(),
    getBankrolls(),
    getBuyins(SEASON),
    getPrizePool(SEASON, 20000),
  ]);

  // Merge claim status into the bankroll rows so one list shows both.
  const claimed = Object.fromEntries(roster.map((r) => [r.slug, r.has_password]));
  const merged = bankrolls.map((b) => ({ ...b, has_password: Boolean(claimed[b.slug]) }));

  return (
    <>
      <p className="page-sub">Password resets, re-ups, and the pot.</p>
      <AdminPanel
        bettors={merged}
        buyins={buyins.map((b) => ({ ...b, id: String(b.id) }))}
        season={SEASON}
        pool={pool}
      />
    </>
  );
}
