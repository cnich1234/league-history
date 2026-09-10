import BetSlip from './BetSlip';

/**
 * League-wide markets: best team, best RB, best WR, best TE.
 *
 * These sit outside the matchup cards because they belong to no matchup. Every
 * lineup in the league is a candidate, so there is no game to file them under
 * and nothing sensible to collapse them into.
 *
 * They are team bets. Backing a manager means backing whoever he started at
 * that position -- if your roster's RB tops the league, that option wins.
 */
export default function SpecialSection({ markets, myByMarket, bankrollCents }) {
  if (!markets?.length) return null;

  const open = markets.filter((m) => m.status === 'open').length;

  return (
    <section className="section">
      <div className="section-head">
        <h2>Special bets</h2>
        <span className="dim">
          {open > 0 ? `${open} open · league-wide` : 'league-wide'}
        </span>
      </div>

      <p className="note" style={{ padding: '0 2px 10px' }}>
        Best in the whole league this week. These are team bets — pick the manager,
        and whoever he started counts.
      </p>

      <div className="special-list">
        {markets.map((m) => (
          <BetSlip
            key={m.id}
            market={m}
            existingBet={myByMarket[String(m.id)]}
            bankrollCents={bankrollCents}
          />
        ))}
      </div>
    </section>
  );
}
