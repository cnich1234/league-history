import BetSlip from './BetSlip';
import MatchupButton from './MatchupButton';

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
export default function MatchupCard({ game, myByMarket, bankrollCents, defaultOpen, week }) {
  const all = KIND_ORDER.flatMap((k) => game.markets[k] ?? []);
  const placed = all.filter((m) => myByMarket[String(m.id)]).length;

  return (
    <details className="matchup" open={defaultOpen}>
      <summary className="matchup-head">
        <span className="matchup-main">
          <span className="matchup-title">{game.title}</span>
          <span className="matchup-meta">
            {game.openCount} of {all.length} open
            {placed > 0 && <span className="matchup-placed"> · {placed} placed</span>}
          </span>
        </span>
        <span className="matchup-chevron" aria-hidden="true" />
      </summary>

      <div className="matchup-body">
        <MatchupButton home={game.homeRoster} away={game.awayRoster} week={week} />

        {KIND_ORDER.filter((k) => game.markets[k]?.length).map((kind) =>
          // Props are per-team and there are eight per roster, so a flat list of
          // sixteen buries the one name you came to bet. Each team's props
          // collapse separately.
          kind === 'prop' && game.markets.prop.length > 6 ? (
            <div className="matchup-kind" key={kind}>
              <div className="matchup-kind-label">{KIND_LABEL[kind]}</div>
              {groupPropsByTeam(game.markets.prop).map(([team, props]) => (
                <details className="prop-team" key={team}>
                  <summary className="prop-team-head">
                    <span className="prop-team-name">{team}</span>
                    <span className="prop-team-meta">
                      {props.length}
                      <span className="kind-chevron" aria-hidden="true" />
                    </span>
                  </summary>
                  {props.map((m) => (
                    <BetSlip
                      key={m.id}
                      market={{ ...m, id: String(m.id), title: m.title, subtitle: m.subtitle }}
                      existingBet={myByMarket[String(m.id)] ?? null}
                      bankrollCents={bankrollCents}
                    />
                  ))}
                </details>
              ))}
            </div>
          ) : (
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
          ),
        )}
      </div>
    </details>
  );
}

/**
 * Props split by the fantasy team whose lineup the player is in, highest
 * projected first. The subtitle already carries "started by <team>", so the
 * team name is pulled from there rather than needing another field.
 */
function groupPropsByTeam(props) {
  const byTeam = new Map();
  for (const p of props) {
    const team = (p.subtitle ?? '').replace(/^.*started by /, '') || 'Other';
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(p);
  }
  return [...byTeam.entries()];
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

