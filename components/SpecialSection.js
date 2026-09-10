import BetSlip from './BetSlip';

/**
 * League-wide markets: best team, best RB, best WR, best TE.
 *
 * These sit outside the matchup cards because they belong to no matchup. Every
 * lineup in the league is a candidate, so there is no game to file them under.
 *
 * They are team bets. Backing a manager means backing whoever he started at
 * that position -- if your roster's RB tops the league, that option wins.
 *
 * One collapsible card per market, matching the matchup cards exactly. Each
 * holds ten options rather than two, so four of them expanded at once is a
 * ninety-row wall between the bankroll and the games.
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

      {markets.map((m) => {
        const placed = Boolean(myByMarket[String(m.id)]);
        return (
          // Closed by default, unlike the first matchup card: these are a
          // sideshow to the week's games, not the main board.
          <details className="matchup" key={m.id}>
            <summary className="matchup-head">
              <span className="matchup-main">
                <span className="matchup-title">{m.title}</span>
                <span className="matchup-meta">
                  {m.status === 'open' ? `${m.options.length} to pick from` : 'closed'}
                  {placed && <span className="matchup-placed"> · bet placed</span>}
                </span>
              </span>
              <span className="matchup-chevron" aria-hidden="true" />
            </summary>

            <div className="matchup-body">
              <BetSlip
                market={m}
                existingBet={myByMarket[String(m.id)]}
                bankrollCents={bankrollCents}
                hideTitle
              />
            </div>
          </details>
        );
      })}
    </section>
  );
}
