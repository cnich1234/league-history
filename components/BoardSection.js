import MatchupCard from './MatchupCard';
import { LiveProvider } from './LiveProvider';

/**
 * The week's board: one card per matchup, every bet on that game inside it.
 *
 * There were day headings above these, with a matchup appearing under each day
 * it had bets on. The league found that convoluted -- the same game listed
 * twice, and no obvious reason why. Each bet now carries its own lock date
 * instead, so one card holds everything and the dates do the explaining.
 */
export default function BoardSection({
  games,
  myByMarket,
  myParlayByMarket,
  oddsBoosts = [],
  slipBoosts = [],
  slowed = null,
  bankrollCents,
  week,
  readOnly,
}) {
  return (
    <LiveProvider week={week}>
    <section className="section">
      <div className="section-head">
        <h2>Week {week}</h2>
        <span className="dim">
          {games.reduce((n, g) => n + g.openCount, 0)} bets open
        </span>
      </div>

      {games.map((g, i) => (
        <MatchupCard
          key={g.key}
          game={g}
          myByMarket={myByMarket}
          myParlayByMarket={myParlayByMarket}
          bankrollCents={bankrollCents}
          week={week}
          readOnly={readOnly}
          oddsBoosts={oddsBoosts}
          slipBoosts={slipBoosts}
          slowed={slowed}
          // Open the first card so the page never looks like a list of empty
          // headers; the rest stay closed so a phone shows all five games.
          defaultOpen={i === 0}
        />
      ))}
    </section>
    </LiveProvider>
  );
}
