import BetSlip from './BetSlip';

const KIND_LABEL = {
  h2h: 'Winner',
  spread: 'Spread',
  total: 'Team totals',
  prop: 'Player props',
};
const KIND_ORDER = ['h2h', 'spread', 'total', 'prop'];

/**
 * One matchup, with every bet available on it behind a tap.
 *
 * The board used to be thirty loose markets grouped by type, which meant the
 * spread on a game sat four sections away from the game itself. Grouping by
 * matchup matches how people actually think -- you decide which game you have
 * an opinion about, then decide how to bet it.
 *
 * Native <details> again: collapses before hydration, works without JS, and
 * keyboard and screen-reader behaviour come for free.
 */
export default function MatchupCard({ game, myByMarket, bankrollCents, defaultOpen }) {
  const all = KIND_ORDER.flatMap((k) => game.markets[k] ?? []);
  const placed = all.filter((m) => myByMarket[String(m.id)]).length;

  return (
    <details className="matchup" open={defaultOpen}>
      <summary className="matchup-head">
        <span className="matchup-main">
          <span className="matchup-title">{game.title}</span>
          <span className="matchup-meta">
            {all.length} bet{all.length === 1 ? '' : 's'}
            {placed > 0 && <span className="matchup-placed"> · {placed} placed</span>}
            {' · '}
            {lockLabel(game.locksAt)}
          </span>
        </span>
        <span className="matchup-chevron" aria-hidden="true" />
      </summary>

      <div className="matchup-body">
        {KIND_ORDER.filter((k) => game.markets[k]?.length).map((kind) => (
          <div className="matchup-kind" key={kind}>
            <div className="matchup-kind-label">{KIND_LABEL[kind]}</div>
            {game.markets[kind].map((m) => (
              <BetSlip
                key={m.id}
                market={{
                  ...m,
                  id: String(m.id),
                  title: shortTitle(m, kind),
                  subtitle: kind === 'h2h' || kind === 'spread' ? null : m.subtitle,
                }}
                existingBet={myByMarket[String(m.id)] ?? null}
                bankrollCents={bankrollCents}
              />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * The matchup header already names the game, so h2h and spread do not need to
 * repeat it. Totals and props name a specific team or player, so they keep
 * their own title.
 */
function shortTitle(market, kind) {
  if (kind === 'h2h') return 'Who wins';
  if (kind === 'spread') return market.subtitle ?? market.title;
  return market.title;
}

/**
 * "closes Sat night" -- markets lock at midnight on the morning of the game,
 * which is the night before in everyone's head. Saying "Sunday" here would be
 * read as Sunday evening, roughly twenty hours too late.
 */
function lockLabel(locksAt) {
  const lock = new Date(locksAt);
  const eve = new Date(lock);
  eve.setUTCDate(eve.getUTCDate() - 1);
  const day = eve.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return `closes ${day} night`;
}
