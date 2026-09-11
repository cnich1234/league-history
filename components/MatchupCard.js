import BetSlip from './BetSlip';
import MatchupButton from './MatchupButton';
import LiveProbability from './LiveProbability';
import LiveMarkets from './LiveMarkets';

const KIND_LABEL = {
  h2h: 'Winner',
  spread: 'Spread',
  showdown: 'Position battles',
  total: 'Team totals',
  prop: 'Player props',
};
const KIND_ORDER = ['h2h', 'spread', 'showdown', 'total', 'prop'];

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
export default function MatchupCard({
  game,
  myByMarket,
  myParlayByMarket = {},
  bankrollCents,
  defaultOpen,
  week,
  readOnly,
}) {
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
        <LiveProbability homeRoster={game.homeRoster} awayRoster={game.awayRoster} />

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
                      parlayLegs={myParlayByMarket[String(m.id)] ?? null}
                      bankrollCents={bankrollCents}
                      disabled={readOnly}
                    />
                  ))}
                </details>
              ))}
            </div>
          ) : (
          <div className="matchup-kind" key={kind}>
            <div className="matchup-kind-label">{KIND_LABEL[kind]}</div>
            <LiveMarkets
              homeRoster={game.homeRoster}
              awayRoster={game.awayRoster}
              markets={game.markets[kind].map((m) => ({
                ...m,
                id: String(m.id),
                title: shortTitle(m, kind),
                subtitle:
                  kind === 'h2h' || (kind === 'spread' && !m.meta?.blowout)
                    ? null
                    : m.subtitle,
              }))}
              myByMarket={myByMarket}
              myParlayByMarket={myParlayByMarket}
              bankrollCents={bankrollCents}
              readOnly={readOnly}
            />
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
  // A blowout asks its own question and both sides are backable. The stored
  // title carries the team names so it is unique across a week, but the card
  // already names them, so show the question instead.
  if (kind === 'spread' && market.meta?.blowout) {
    return `Either team by ${market.meta.spread}+?`;
  }
  if (kind === 'spread') return market.subtitle ?? market.title;
  // "Deebo my Lemons WRs -5.5 vs Mike R WRs" is too long for a phone once the
  // card already names both teams. The option labels carry the detail.
  if (kind === 'showdown') return `${market.meta?.position ?? ''} battle`.trim();
  return market.title;
}

