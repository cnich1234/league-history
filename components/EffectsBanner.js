/**
 * What is bending the board this week.
 *
 * Only the things that change what a market is worth to EVERYONE, plus the
 * week-wide multipliers. Blind attacks on individual bets are deliberately
 * absent: their whole value is that the victim does not know, and listing them
 * would refund the attacker's points in information.
 *
 * Server component -- it renders from data and has no state of its own.
 */
export default function EffectsBanner({ effects }) {
  const markets = effects?.markets ?? [];
  const weekly = effects?.weekly ?? [];
  if (markets.length === 0 && weekly.length === 0) return null;

  return (
    <section className="section">
      <div className="effects">
        <div className="effects-head">⚠️ In play this week</div>
        <ul className="effects-list">
          {markets.map((m) => (
            <li key={m.marketId}>
              <span className="effects-icon" aria-hidden="true">
                ☠️
              </span>
              <span>
                <strong>{m.title}</strong> is poisoned — every price on it is worse by{' '}
                {Math.round(m.bump * 100)}%.{' '}
                <span className="dim">Thank {m.by}.</span>
              </span>
            </li>
          ))}
          {weekly.map((w, i) => (
            <li key={`${w.kind}-${w.who}-${i}`}>
              <span className="effects-icon" aria-hidden="true">
                {w.kind === 'boost-week' ? '🚀' : '💢'}
              </span>
              {w.kind === 'boost-week' ? (
                <span>
                  <strong>{w.who}</strong> declared a Big Week — every bet they win pays{' '}
                  {w.pct}% more.
                </span>
              ) : (
                <span>
                  <strong>{w.who}</strong> is cursed — everything they win this week is cut
                  by {w.pct}%. <span className="dim">Thank {w.by}.</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
