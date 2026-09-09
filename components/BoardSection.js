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
 *
 * Matchups and spreads almost always land on the earliest group: a lineup locks
 * before ANY of its starters plays, and with twenty starters at least one is
 * usually in the Thursday game. That is deliberate -- betting a matchup after
 * one of its players has already scored is not a bet -- but it surprises
 * people, so the group says why.
 *
 * Categories collapse via native <details>, not React state: it works before
 * hydration, survives a failed script load, and gets keyboard and screen-reader
 * behaviour for free. Head to head opens by default because it is the bet
 * everyone came for; the ten player props do not need to push everything else
 * off a phone screen.
 */
export default function BoardSection({ markets, myByMarket, bankrollCents }) {
  const byDay = {};
  for (const m of markets) {
    const key = new Date(m.locks_at).toISOString().slice(0, 10);
    (byDay[key] ??= []).push(m);
  }

  const days = Object.keys(byDay).sort();

  return days.map((day, i) => {
    const dayMarkets = byDay[day];
    const isEarliest = i === 0;
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
        {isEarliest && hasLineupMarkets(dayMarkets) && (
          <p className="day-why">
            Matchups and spreads close now because at least one starter plays{' '}
            {dayLabel(day).replace(' games', '')}.
          </p>
        )}

        {KIND_ORDER.filter((k) => byKind[k]?.length).map((kind) => (
          <details className="kind-group" key={kind} open={kind === 'h2h'}>
            <summary className="kind-label">
              <span className="kind-name">{KIND_LABEL[kind]}</span>
              <span className="kind-meta">
                {betCount(byKind[kind], myByMarket)}
                <span className="kind-chevron" aria-hidden="true" />
              </span>
            </summary>
            {byKind[kind].map((m) => (
              <BetSlip
                key={m.id}
                market={{ ...m, id: String(m.id) }}
                existingBet={myByMarket[String(m.id)] ?? null}
                bankrollCents={bankrollCents}
              />
            ))}
          </details>
        ))}
      </section>
    );
  });
}

/**
 * "6 bets · 2 placed" -- so a collapsed group still says whether you have acted
 * on it, which is the one thing worth knowing without opening it.
 */
function betCount(markets, myByMarket) {
  const placed = markets.filter((m) => myByMarket[String(m.id)]).length;
  const label = `${markets.length} bet${markets.length === 1 ? '' : 's'}`;
  return placed ? `${label} · ${placed} placed` : label;
}

/** True when a group contains whole-lineup markets, which lock earliest. */
function hasLineupMarkets(markets) {
  return markets.some((m) => m.kind === 'h2h' || m.kind === 'spread');
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
