import { currentBettor, isCommissioner } from '@/lib/auth';
import { settledBets, settledSummary } from '@/lib/book';
import { formatMoney, formatOdds } from '@/lib/odds';
import BookTabs from '@/components/BookTabs';

export const metadata = { title: 'Results' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export default async function ResultsPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <main className="page">
        <header className="page-head">
          <h1>Results</h1>
        </header>
        <section className="section">
          <div className="empty">Sign in on the board to see results.</div>
        </section>
      </main>
    );
  }

  const [bets, summary, commissioner] = await Promise.all([
    settledBets(SEASON),
    settledSummary(SEASON),
    isCommissioner(),
  ]);

  // Group by week so a long season stays readable.
  const byWeek = {};
  for (const b of bets) (byWeek[b.week] ??= []).push(b);
  const weeks = Object.keys(byWeek)
    .map(Number)
    .sort((a, b) => b - a);

  return (
    <main className="page">
      <header className="page-head">
        <h1>Results</h1>
        <p className="dim">Every settled bet in the league.</p>
      </header>

      <BookTabs commissioner={commissioner} />

      {summary.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Profit and loss</h2>
          </div>
          <div className="rows">
            {summary.map((s, i) => (
              <div key={s.bettor} className={`row ${s.bettor === slug ? 'row-me' : ''}`}>
                <span className="rank">{i + 1}</span>
                <span className="row-main">
                  <span className="row-name">{s.display_name}</span>
                  <span className="dim">
                    {s.wins}-{s.losses}
                    {s.refunded > 0 && ` · ${s.refunded} refunded`} · {formatMoney(s.wagered_cents)}{' '}
                    wagered
                  </span>
                </span>
                <span className={`row-value ${Number(s.net_cents) < 0 ? 'neg' : 'pos'}`}>
                  {Number(s.net_cents) >= 0 ? '+' : '−'}
                  {formatMoney(Math.abs(Number(s.net_cents)))}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {weeks.length === 0 ? (
        <section className="section">
          <div className="empty">Nothing settled yet. Results appear after each week.</div>
        </section>
      ) : (
        weeks.map((week) => (
          <section className="section" key={week}>
            <div className="section-head">
              <h2>Week {week}</h2>
              <span className="dim">{byWeek[week].length} bets</span>
            </div>
            <div className="rows">
              {byWeek[week].map((b) => (
                <div key={b.id} className={`row ${b.bettor === slug ? 'row-me' : ''}`}>
                  <span className="row-main">
                    <span className="row-name">
                      {b.bettor_name} · {b.option_label}
                    </span>
                    <span className="dim">
                      {b.title} · {formatMoney(b.stake_cents)} at {formatOdds(b.odds)}
                    </span>
                  </span>
                  <span className={`row-value ${resultClass(b.status)}`}>{resultLabel(b)}</span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

function resultLabel(bet) {
  const stake = Number(bet.stake_cents);
  const payout = Number(bet.payout_cents ?? 0);
  if (bet.status === 'won') return `+${formatMoney(payout - stake)}`;
  if (bet.status === 'lost') return `−${formatMoney(stake)}`;
  if (bet.status === 'void') return 'void';
  return 'push';
}

function resultClass(status) {
  if (status === 'won') return 'pos';
  if (status === 'lost') return 'neg';
  return 'dim';
}
