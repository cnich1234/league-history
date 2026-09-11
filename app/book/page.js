import { redirect } from 'next/navigation';
import { currentBettor, listBettors, isCommissioner, isGuestSlug } from '@/lib/auth';
import {
  getBettor,
  getMarketsForWeek,
  getMyBets,
  visibleBets,
  getPrizePool,
  groupByMatchup,
  parlayLegsFor,
  weeksWithMarkets,
  weeklyBalance,
  getBanks,
} from '@/lib/book';
import { getArmedBoosts } from '@/lib/shop';
import { formatMoney, formatOdds } from '@/lib/odds';
import Login from '@/components/Login';
import BoardSection from '@/components/BoardSection';
import { SlipProvider } from '@/components/SlipProvider';
import ParlaySlip from '@/components/ParlaySlip';
import SpecialSection from '@/components/SpecialSection';
import WeekSwitcher from '@/components/WeekSwitcher';

export const metadata = { title: 'The Book' };
// Reads a session cookie and live odds, so this page can never be prerendered.
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/** Drops the session and returns to the picker. A guest's only way back. */
async function signOut() {
  'use server';
  const { clearSession } = await import('@/lib/auth');
  await clearSession();
  redirect('/book');
}

export default async function BookPage({ searchParams }) {
  const params = await searchParams;
  const week = Number(params?.week ?? process.env.BOOK_WEEK ?? 1);

  const [slug, pool] = await Promise.all([
    currentBettor(),
    getPrizePool(SEASON, 30000),
  ]);

  if (!slug) {
    // The login list needs claim status, which the bankroll view does not carry.
    const roster = await listBettors();
    return (
      <section className="section">
        <p className="dim" style={{ marginTop: -6, marginBottom: 14 }}>
          Play-money sportsbook. Most in the bank at the end wins $300.
        </p>
        <Login bettors={roster} />
      </section>
    );
  }

  // A guest is signed in but is not a bettor: no bankroll row, no bets of its
  // own. Skipping those two queries is not an optimisation, it is the point --
  // there is nothing for them to return.
  const guest = isGuestSlug(slug);

  const [me, markets, myBets, publicBets, commissioner, weeks, spendable, banks, armed] =
    await Promise.all([
    guest ? null : getBettor(slug),
    getMarketsForWeek(SEASON, week),
    guest ? [] : getMyBets(slug),
    visibleBets(SEASON, week),
    isCommissioner(),
    weeksWithMarkets(SEASON),
    // What you can bet THIS WEEK, and what you have banked for the season.
    // The old bankrolls view is a season-long pot that no longer exists.
    guest ? 0 : weeklyBalance(slug, week),
    getBanks(),
    // Anything armed and waiting to fire. Better Price is consumed by the very
    // next bet placed, so not showing it meant someone could spend it on a $10
    // punt without realising it was live.
    guest ? [] : getArmedBoosts(slug, SEASON, week),
  ]);
  const myBank = Number(banks.find((b) => b.slug === slug)?.bank_cents ?? 0);

  // Parlays have no market_id, so they cannot key this map -- and including
  // them would collide on the "null" key and mark unrelated markets as placed.
  const myByMarket = Object.fromEntries(
    myBets.filter((b) => !b.is_parlay).map((b) => [String(b.market_id), b]),
  );
  const myLegs = await parlayLegsFor(myBets.filter((b) => b.is_parlay).map((b) => b.id));

  // Markets you are on through a PARLAY leg rather than a straight bet. Without
  // this the board showed nothing on them: a parlay has no market_id of its
  // own, so myByMarket above cannot see it, and a market you had already backed
  // looked identical to one you had never touched.
  const myParlayByMarket = {};
  for (const legs of Object.values(myLegs)) {
    for (const leg of legs) {
      if (leg.market_id == null) continue;
      (myParlayByMarket[String(leg.market_id)] ??= []).push(leg);
    }
  }
  const now = Date.now();

  const open = markets.filter((m) => new Date(m.locks_at).getTime() > now);
  const locked = markets.filter((m) => new Date(m.locks_at).getTime() <= now);
  const anyOpen = open.length > 0;
  // Matchup drilldown: pick the game, then how to bet it.
  //
  // Locked matchups stay on the board, greyed out. Dropping them made three of
  // five games disappear on a Wednesday and read as "markets are missing"
  // rather than "these already closed".
  // Pass the full market list as the second argument: pairings must come from
  // every h2h in the week, or a matchup that has already locked takes its
  // still-open props down with it.
  const games = groupByMatchup(markets, markets);
  // League-wide markets belong to no matchup, so groupByMatchup drops them --
  // they get their own section above the board.
  const specials = markets.filter((m) => m.kind === 'special');

  // Other people's bets, only from markets that have already locked.
  const others = publicBets.filter((b) => b.bettor !== slug);

  return (
    <>
      <p className="page-sub">
        Week {week} · pot {formatMoney(pool.totalCents)}
        {pool.buyinsOutstanding > 0 && ` (+${formatMoney(pool.outstandingCents)} owed)`}
      </p>

      <WeekSwitcher weeks={weeks} current={week} />

      {armed.length > 0 && (
        <div className="armed-banner">
          {armed.map((a) => (
            <span key={a.id} className="armed-chip">
              {a.icon} <strong>{a.name}</strong> {a.note}
            </span>
          ))}
        </div>
      )}

      {guest ? (
        <section className="section">
          <div className="guest-card">
            <div>
              <div className="guest-title">Watching as a guest</div>
              <div className="dim">
                Read-only. Prices, standings and results — but no betting.
              </div>
            </div>
            <form action={signOut}>
              <button className="guest-switch" type="submit">
                Sign in
              </button>
            </form>
          </div>
        </section>
      ) : (
        <section className="section">
          <div className="bankroll-card">
            <div>
              <div className="dim">To bet this week</div>
              <div className="bankroll-amount">{formatMoney(spendable)}</div>
            </div>
            <div className="bankroll-record">
              {/* The bank is the prize. The weekly figure resets; this does not. */}
              <div className="bank-line">
                Banked <strong>{formatMoney(myBank)}</strong>
              </div>
              <div className="dim">
                <span className="pos">{me.wins}W</span> · <span className="neg">{me.losses}L</span>
                {me.pending > 0 && <> · {me.pending} pending</>}
              </div>
            </div>
          </div>
        </section>
      )}

      {!anyOpen && games.length > 0 && (
        <section className="section">
          <div className="empty">
            Every market for week {week} has closed. New markets appear Tuesday.
          </div>
        </section>
      )}

      {games.length > 0 || specials.length > 0 ? (
        <SlipProvider>
          <SpecialSection
            markets={specials}
            myByMarket={myByMarket}
            myParlayByMarket={myParlayByMarket}
            bankrollCents={guest ? 0 : spendable}
            // Open when there is nothing else on the board, so the page is not
            // a single collapsed heading; closed when the week's games are
            // there to lead with.
            defaultOpen={games.length === 0}
            readOnly={guest}
          />
          {games.length > 0 && (
            <BoardSection
              games={games}
              myByMarket={myByMarket}
              myParlayByMarket={myParlayByMarket}
              bankrollCents={guest ? 0 : spendable}
              week={week}
              readOnly={guest}
            />
          )}
          {!guest && <ParlaySlip bankrollCents={spendable} />}
        </SlipProvider>
      ) : (
        <section className="section">
          <div className="empty">
            Nothing open for week {week}. Markets appear once the week is built.
          </div>
        </section>
      )}

      {!guest && myBets.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>My bets</h2>
          </div>
          <div className="rows">
            {myBets.slice(0, 12).map((b) => (
              <div key={b.id} className="row">
                <span className="row-main">
                  <span className="row-name">
                    {b.is_parlay ? `${b.leg_count}-leg parlay` : b.title}
                  </span>
                  <span className="dim">
                    {b.is_parlay
                      ? (myLegs[b.id] ?? []).map((l) => l.option_label).join(' + ')
                      : b.option_label}{' '}
                    · {formatMoney(b.stake_cents)} at {formatOdds(b.odds)}
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
          <span className="dim">everyone&apos;s closed bets</span>
        </div>
        {others.length === 0 ? (
          <div className="empty">
            Everyone&apos;s bets show up here once their market closes and nobody can act on
            them. Nothing has closed yet.
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


    </>
  );
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
