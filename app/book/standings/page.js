import { currentBettor } from '@/lib/auth';
import {
  getBanks,
  getPrizePool,
  settledSummary,
  settledBets,
  parlayLegsFor,
  weeklyBalances,
  currentWeek,
} from '@/lib/book';
import { formatMoney, formatOdds } from '@/lib/odds';

export const metadata = { title: 'Standings' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export default async function StandingsPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see standings.</div>
      </section>
    );
  }

  const WEEK = await currentWeek(SEASON);
  const [banks, weekly, pool, summary, bets] = await Promise.all([
    getBanks(),
    weeklyBalances(WEEK),
    getPrizePool(SEASON, 30000),
    settledSummary(SEASON),
    settledBets(SEASON, 500),
  ]);

  const legs = await parlayLegsFor(bets.filter((b) => b.is_parlay).map((b) => b.id));

  const summaryBySlug = Object.fromEntries(summary.map((s) => [s.bettor, s]));
  const betsBySlug = {};
  for (const b of bets) (betsBySlug[b.bettor] ??= []).push(b);

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
          <h2>The bank</h2>
          <span className="dim">tap for settled bets</span>
        </div>

        <div className="standings-head">
          <span className="sh-rank" />
          <span className="sh-name">Manager</span>
          <span className="sh-record">W-L</span>
          <span className="sh-money">Banked</span>
        </div>

        {banks.map((b, i) => {
          const mine = b.slug === slug;
          const theirs = betsBySlug[b.slug] ?? [];
          const s = summaryBySlug[b.slug];
          // What is left to bet this week, shown under the banked total. The
          // old $1,000 opening bankroll is gone: money is a weekly allowance
          // that resets, and only profit survives into the bank.
          const spendable = Number(
            weekly.find((w) => w.slug === b.slug)?.balance_cents ?? 0,
          );

          return (
            <details className={`standing ${mine ? 'standing-me' : ''}`} key={b.slug}>
              <summary className="standing-row">
                <span className="sh-rank">{i + 1}</span>
                <span className="sh-name">
                  <span className="standing-name">{b.display_name}</span>
                  {b.pending > 0 && <span className="dim"> · {b.pending} pending</span>}
                </span>
                <span className="sh-record">
                  {b.wins}-{b.losses}
                  {s?.refunded > 0 && <span className="dim">-{s.refunded}</span>}
                </span>
                <span className="sh-money">
                  <span className="row-value">{formatMoney(b.bank_cents)}</span>
                  {/* Always rendered so every row is the same height. */}
                  <span className="row-swing dim">
                    {formatMoney(spendable)} left
                  </span>
                </span>
              </summary>

              <div className="standing-body">
                {theirs.length === 0 ? (
                  <p className="slip-note">No settled bets yet.</p>
                ) : (
                  theirs.map((bet) => (
                    <div className="settled-bet" key={bet.id}>
                      <span className="settled-main">
                        <span className="settled-pick">
                          {bet.is_parlay
                            ? `${bet.leg_count}-leg parlay`
                            : (bet.option_label ?? bet.option_key)}
                        </span>
                        <span className="settled-market">
                          {bet.is_parlay
                            ? (legs[bet.id] ?? [])
                                .map((l) => `${l.option_label} (${l.status})`)
                                .join(' · ')
                            : `Week ${bet.week} · ${bet.title}`}
                        </span>
                      </span>
                      <span className="settled-money">
                        <span className={`settled-result ${resultClass(bet.status)}`}>
                          {resultLabel(bet)}
                        </span>
                        <span className="settled-stake">
                          {formatMoney(bet.stake_cents)} at {formatOdds(bet.odds)}
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </details>
          );
        })}
      </section>
    </>
  );
}

function resultLabel(bet) {
  const stake = Number(bet.stake_cents);
  const payout = Number(bet.payout_cents ?? 0);
  if (bet.status === 'won') return `+${formatMoney(payout - stake)}`;
  if (bet.status === 'lost') return `−${formatMoney(stake)}`;
  if (bet.status === 'void') return 'void';
  if (bet.status === 'cashed') return `cashed ${formatMoney(payout)}`;
  return 'push';
}

function resultClass(status) {
  if (status === 'won') return 'pos';
  if (status === 'lost') return 'neg';
  return 'dim';
}
