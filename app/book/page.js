import { currentBettor, listBettors, isCommissioner } from '@/lib/auth';
import {
  getBettor,
  getMarketsForWeek,
  getMyBets,
  visibleBets,
  getPrizePool,
  groupByMatchup,
  parlayLegsFor,
} from '@/lib/book';
import { formatMoney, formatOdds } from '@/lib/odds';
import Login from '@/components/Login';
import BoardSection from '@/components/BoardSection';
import { SlipProvider } from '@/components/SlipProvider';
import ParlaySlip from '@/components/ParlaySlip';
import SpecialSection from '@/components/SpecialSection';

export const metadata = { title: 'The Book' };
// Reads a session cookie and live odds, so this page can never be prerendered.
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export default async function BookPage({ searchParams }) {
  const params = await searchParams;
  const week = Number(params?.week ?? process.env.BOOK_WEEK ?? 1);

  const [slug, pool] = await Promise.all([
    currentBettor(),
    getPrizePool(SEASON, 20000),
  ]);

  if (!slug) {
    // The login list needs claim status, which the bankroll view does not carry.
    const roster = await listBettors();
    return (
      <section className="section">
        <p className="dim" style={{ marginTop: -6, marginBottom: 14 }}>
          Play-money sportsbook. Most money at the end wins $200.
        </p>
        <Login bettors={roster} />
      </section>
    );
  }

  const [me, markets, myBets, publicBets, commissioner] = await Promise.all([
    getBettor(slug),
    getMarketsForWeek(SEASON, week),
    getMyBets(slug),
    visibleBets(SEASON, week),
    isCommissioner(),
  ]);

  // Parlays have no market_id, so they cannot key this map -- and including
  // them would collide on the "null" key and mark unrelated markets as placed.
  const myByMarket = Object.fromEntries(
    myBets.filter((b) => !b.is_parlay).map((b) => [String(b.market_id), b]),
  );
  const myLegs = await parlayLegsFor(myBets.filter((b) => b.is_parlay).map((b) => b.id));
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
            bankrollCents={Number(me.balance_cents)}
          />
          {games.length > 0 && (
            <BoardSection
              games={games}
              myByMarket={myByMarket}
              bankrollCents={Number(me.balance_cents)}
              week={week}
            />
          )}
          <ParlaySlip bankrollCents={Number(me.balance_cents)} />
        </SlipProvider>
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
