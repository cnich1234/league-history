import BetSlip from './BetSlip';

const KIND_LABEL = {
  h2h: 'Head to head',
  spread: 'Spreads',
  total: 'Team totals',
  prop: 'Player props',
};
const KIND_ORDER = ['h2h', 'spread', 'total', 'prop'];

/**
 * The week's board, grouped by lock day and then by bet type.
 *
 * Lock day is the outer grouping because it is the thing that actually costs
 * someone money if they misread it. Markets lock on their own game day, so a
 * flat list mixes "closes tonight" with "closes Sunday" and the only hint is a
 * small label -- which is exactly the confusion this avoids.
 */
export default function BoardSection({ markets, myByMarket, bankrollCents }) {
  const byDay = {};
  for (const m of markets) {
    const key = new Date(m.locks_at).toISOString().slice(0, 10);
    (byDay[key] ??= []).push(m);
  }

  const days = Object.keys(byDay).sort();

  return days.map((day) => {
    const dayMarkets = byDay[day];
    const byKind = {};
    for (const m of dayMarkets) (byKind[m.kind] ??= []).push(m);

    return (
      <section className="section" key={day}>
        <div className="day-head">
          <h2>{dayLabel(day)}</h2>
          <span className="day-count">
            {dayMarkets.length} bet{dayMarkets.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="day-note">Closes {closesLabel(day)}</p>

        {KIND_ORDER.filter((k) => byKind[k]?.length).map((kind) => (
          <div className="kind-group" key={kind}>
            <div className="kind-label">{KIND_LABEL[kind]}</div>
            {byKind[kind].map((m) => (
              <BetSlip
                key={m.id}
                market={{ ...m, id: String(m.id) }}
                existingBet={myByMarket[String(m.id)] ?? null}
                bankrollCents={bankrollCents}
              />
            ))}
          </div>
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
