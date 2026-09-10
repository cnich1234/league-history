import MatchupCard from './MatchupCard';

/**
 * The week's board: matchups, grouped by the day they lock.
 *
 * Two levels, both earning their place. Lock day is the outer grouping because
 * misreading it is what costs someone a bet -- a flat list mixes "closes
 * tonight" with "closes Saturday" and the only hint is a small label. Matchup
 * is the inner grouping because that is how people decide: pick the game you
 * have an opinion about, then pick how to bet it.
 *
 * Matchups almost always land in the earliest group. A lineup locks before ANY
 * of its starters plays, and with twenty starters at least one is usually in
 * the Thursday game. That is deliberate -- betting a matchup after one of its
 * players has already scored is not a bet -- but it surprises people, so the
 * earliest group says why.
 */
export default function BoardSection({ games, myByMarket, bankrollCents, week }) {
  const byDay = {};
  for (const g of games) {
    const key = new Date(g.locksAt).toISOString().slice(0, 10);
    (byDay[key] ??= []).push(g);
  }

  const days = Object.keys(byDay).sort();

  return days.map((day, i) => {
    const dayGames = byDay[day];
    const isEarliest = i === 0;
    const betCount = dayGames.reduce((n, g) => n + g.marketCount, 0);

    return (
      <section className="section" key={day}>
        <div className="day-head">
          <h2>{dayLabel(day)}</h2>
          <span className="day-count">
            {dayGames.length} game{dayGames.length === 1 ? '' : 's'} · {betCount} bets
          </span>
        </div>
        <p className="day-note">Closes {closesLabel(day)}</p>
        {isEarliest && (
          <p className="day-why">
            These close first because at least one starter plays{' '}
            {dayLabel(day).replace(' games', '')}.
          </p>
        )}

        {dayGames.map((g, j) => (
          <MatchupCard
            key={g.key}
            game={g}
            myByMarket={myByMarket}
            bankrollCents={bankrollCents}
            week={week}
            // Open the first card so the page never looks like a list of empty
            // headers; the rest stay closed so a phone shows all five games.
            defaultOpen={isEarliest && j === 0}
          />
        ))}
      </section>
    );
  });
}

/** "Sunday games" -- what the bets are ON, not when they close. */
function dayLabel(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return `${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} games`;
}

/**
 * Markets lock at midnight Arizona on the morning of the game, which is the
 * night before in everyone's head. Saying "Saturday night" avoids the classic
 * off-by-one where someone reads "midnight Sunday" as Sunday evening.
 */
function closesLabel(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const eve = new Date(d);
  eve.setUTCDate(eve.getUTCDate() - 1);
  const evening = eve.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const morning = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `${evening} at midnight (${morning})`;
}
