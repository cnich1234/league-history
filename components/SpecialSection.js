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
 * ONE collapsible for the whole section, the same shell a matchup card uses.
 * The markets inside are a plain list: collapsing each of them individually
 * meant four taps to see four markets, and hid the prices behind headings that
 * all looked alike.
 */
export default function SpecialSection({
  markets,
  myByMarket,
  myParlayByMarket = {},
  oddsBoosts = [],
  slowed = null,
  bankrollCents,
  defaultOpen,
  readOnly,
}) {
  if (!markets?.length) return null;

  const open = markets.filter((m) => m.status === 'open').length;
  const placed = markets.filter((m) => myByMarket[String(m.id)]).length;

  return (
    <section className="section">
      <details className="matchup" open={defaultOpen}>
        <summary className="matchup-head">
          <span className="matchup-main">
            <span className="matchup-title">Special bets</span>
            <span className="matchup-meta">
              {open} of {markets.length} open · league-wide
              {placed > 0 && <span className="matchup-placed"> · {placed} placed</span>}
            </span>
          </span>
          <span className="matchup-chevron" aria-hidden="true" />
        </summary>

        <div className="matchup-body">
          <p className="note" style={{ padding: '0 2px 10px' }}>
            Best in the whole league this week. These are team bets — pick the manager,
            and whoever he started counts.
          </p>

          {markets.map((m) => (
            <BetSlip
              key={m.id}
              market={m}
              existingBet={myByMarket[String(m.id)]}
              parlayLegs={myParlayByMarket[String(m.id)] ?? null}
              bankrollCents={bankrollCents}
              disabled={readOnly}
              oddsBoosts={oddsBoosts}
              slowed={slowed}
            />
          ))}
        </div>
      </details>
    </section>
  );
}
