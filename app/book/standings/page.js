import { currentBettor } from '@/lib/auth';
import { getBankrolls, getPrizePool, settledSummary } from '@/lib/book';
import { formatMoney } from '@/lib/odds';

export const metadata = { title: 'Standings' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const OPENING_CENTS = 100000;

export default async function StandingsPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see standings.</div>
      </section>
    );
  }

  const [bankrolls, pool, summary] = await Promise.all([
    getBankrolls(),
    getPrizePool(SEASON, 20000),
    settledSummary(SEASON),
  ]);

  const netBySlug = Object.fromEntries(summary.map((s) => [s.bettor, Number(s.net_cents)]));

  return (
    <>
      <p className="page-sub">Most money at the end of the season wins the pot.</p>

      <section className="section">
        <div className="bankroll-card">
          <div>
            <div className="dim">Prize pool</div>
            <div className="bankroll-amount">{formatMoney(pool.totalCents)}</div>
          </div>
          <div className="bankroll-record">
            {formatMoney(pool.baseCents)} base
            {pool.buyinsCollected > 0 && (
              <>
                <br />+{pool.buyinsCollected} re-up{pool.buyinsCollected === 1 ? '' : 's'}
              </>
            )}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Bankrolls</h2>
        </div>
        <div className="rows">
          {bankrolls.map((b, i) => {
            // Change against the $1,000 everyone started with, which reads more
            // usefully than the raw balance once re-ups are in play.
            const swing = Number(b.balance_cents) - OPENING_CENTS;
            return (
              <div key={b.slug} className={`row ${b.slug === slug ? 'row-me' : ''}`}>
                <span className="rank">{i + 1}</span>
                <span className="row-main">
                  <span className="row-name">{b.display_name}</span>
                  <span className="dim">
                    {b.wins}-{b.losses}
                    {b.pending > 0 && ` · ${b.pending} pending`}
                    {netBySlug[b.slug] != null &&
                      ` · ${netBySlug[b.slug] >= 0 ? '+' : '−'}${formatMoney(
                        Math.abs(netBySlug[b.slug]),
                      )} settled`}
                  </span>
                </span>
                <span className="row-stack">
                  <span className="row-value">{formatMoney(b.balance_cents)}</span>
                  {swing !== 0 && (
                    <span className={`row-swing ${swing < 0 ? 'neg' : 'pos'}`}>
                      {swing > 0 ? '+' : '−'}
                      {formatMoney(Math.abs(swing))}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
