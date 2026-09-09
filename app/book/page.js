import Link from 'next/link';
import { currentBettor } from '@/lib/auth';
import {
  getBankrolls,
  getBettor,
  getMarketsForWeek,
  getMyBets,
  visibleBets,
  getPrizePool,
} from '@/lib/book';
import { formatMoney, formatOdds } from '@/lib/odds';
import Login from '@/components/Login';
import BetSlip from '@/components/BetSlip';

export const metadata = { title: 'The Book' };
// Reads a session cookie and live odds, so this page can never be prerendered.
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const KIND_LABEL = {
  h2h: 'Head to head',
  spread: 'Spreads',
  total: 'Team totals',
  prop: 'Player props',
};

export default async function BookPage({ searchParams }) {
  const params = await searchParams;
  const week = Number(params?.week ?? process.env.BOOK_WEEK ?? 1);

  const [slug, bankrolls, pool] = await Promise.all([
    currentBettor(),
    getBankrolls(),
    getPrizePool(SEASON, 20000),
  ]);

  if (!slug) {
    return (
      <main className="page">
        <header className="page-head">
          <h1>The Book</h1>
          <p className="dim">Play-money sportsbook. Most money at the end wins $200.</p>
        </header>
        <section className="section">
          <Login bettors={bankrolls} />
        </section>
      </main>
    );
  }

  const [me, markets, myBets, publicBets] = await Promise.all([
    getBettor(slug),
    getMarketsForWeek(SEASON, week),
    getMyBets(slug),
    visibleBets(SEASON, week),
  ]);

  const myByMarket = Object.fromEntries(myBets.map((b) => [String(b.market_id), b]));
  const now = Date.now();

  const open = markets.filter((m) => new Date(m.locks_at).getTime() > now);
  const locked = markets.filter((m) => new Date(m.locks_at).getTime() <= now);

  // Group open markets by kind so the board reads like a sportsbook rather than
  // one undifferentiated list of thirty things.
  const byKind = {};
  for (const m of open) (byKind[m.kind] ??= []).push(m);

  // Other people's bets, only from markets that have already locked.
  const others = publicBets.filter((b) => b.bettor !== slug);

  return (
    <main className="page">
      <header className="page-head">
        <h1>The Book</h1>
        <p className="dim">
          Week {week} · pot {formatMoney(pool.totalCents)}
          {pool.buyinsOutstanding > 0 && ` (+${formatMoney(pool.outstandingCents)} owed)`}
        </p>
      </header>

      <section className="section">
        <div className="bankroll-card">
          <div>
            <div className="dim">{me.display_name}</div>
            <div className="bankroll-amount">{formatMoney(me.balance_cents)}</div>
          </div>
          <div className="bankroll-record">
            <span className="pos">{me.wins}W</span> · <span className="neg">{me.losses}L</span>
            {me.pending > 0 && <> · {me.pending} pending</>}
          </div>
        </div>
      </section>

      {open.length > 0 ? (
        Object.entries(KIND_LABEL).map(([kind, label]) =>
          byKind[kind]?.length ? (
            <section className="section" key={kind}>
              <div className="section-head">
                <h2>{label}</h2>
                <span className="dim">{lockSummary(byKind[kind])}</span>
              </div>
              {byKind[kind].map((m) => (
                <BetSlip
                  key={m.id}
                  market={{ ...m, id: String(m.id) }}
                  existingBet={myByMarket[String(m.id)] ?? null}
                  bankrollCents={Number(me.balance_cents)}
                />
              ))}
            </section>
          ) : null,
        )
      ) : (
        <section className="section">
          <div className="empty">
            Nothing open for week {week}. Markets appear once the week is built.
          </div>
        </section>
      )}

      {myBets.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>My bets</h2>
          </div>
          <div className="rows">
            {myBets.slice(0, 12).map((b) => (
              <div key={b.id} className="row">
                <span className="row-main">
                  <span className="row-name">{b.title}</span>
                  <span className="dim">
                    {b.option_label} · {formatMoney(b.stake_cents)} at {formatOdds(b.odds)}
                  </span>
                </span>
                <span className={`row-value ${statusClass(b.status)}`}>{statusLabel(b)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>The floor</h2>
          <span className="dim">{locked.length} market(s) locked</span>
        </div>
        {others.length === 0 ? (
          <div className="empty">
            Everyone&apos;s bets appear here once a market locks. Nothing locked yet.
          </div>
        ) : (
          <div className="rows">
            {others.map((b) => (
              <div key={b.id} className="row">
                <span className="row-main">
                  <span className="row-name">
                    {b.bettor_name} · {b.option_label}
                  </span>
                  <span className="dim">
                    {b.title} · {formatMoney(b.stake_cents)} at {formatOdds(b.odds)}
                  </span>
                </span>
                <span className={`row-value ${statusClass(b.status)}`}>{statusLabel(b)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Standings</h2>
        </div>
        <div className="rows">
          {bankrolls.map((b, i) => (
            <div key={b.slug} className={`row ${b.slug === slug ? 'row-me' : ''}`}>
              <span className="rank">{i + 1}</span>
              <span className="row-main">
                <span className="row-name">{b.display_name}</span>
                <span className="dim">
                  {b.wins}-{b.losses}
                  {b.pending > 0 && ` · ${b.pending} pending`}
                </span>
              </span>
              <span className="row-value">{formatMoney(b.balance_cents)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <Link className="dim" href="/book/rules">
          House rules →
        </Link>
      </section>
    </main>
  );
}

/** "locks Thu, Sun" -- markets in one group can lock on different days. */
function lockSummary(markets) {
  const days = [
    ...new Set(
      markets.map((m) =>
        new Date(m.locks_at).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
      ),
    ),
  ];
  return `locks ${days.join(', ')}`;
}

function statusLabel(bet) {
  if (bet.status === 'won') return `+${formatMoney(Number(bet.payout_cents) - Number(bet.stake_cents))}`;
  if (bet.status === 'lost') return `-${formatMoney(bet.stake_cents)}`;
  if (bet.status === 'push') return 'push';
  return 'pending';
}

function statusClass(status) {
  if (status === 'won') return 'pos';
  if (status === 'lost') return 'neg';
  return 'dim';
}
