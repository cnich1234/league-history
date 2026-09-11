import { currentBettor, isGuestSlug } from '@/lib/auth';
import { attackableBets, weeksWithMarkets } from '@/lib/book';
import { getInventory, openBounties, getPoints, minimumStake } from '@/lib/shop';
import { listBettors } from '@/lib/auth';
import { byKind, BOOSTS } from '@/lib/boosts';
import { formatMoney, formatOdds, payoutCents } from '@/lib/odds';
import AttackButton from '@/components/AttackButton';

export const metadata = { title: 'The Action' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * The week this page is about.
 *
 * Read from the data rather than from BOOK_WEEK, which is not set in any
 * environment -- so this page was pinned to week 1 all season while the board
 * moved on. The latest week with markets is the one people are betting.
 */
async function currentWeek() {
  const weeks = await weeksWithMarkets(SEASON);
  if (!weeks.length) return Number(process.env.BOOK_WEEK ?? 1);
  const live = weeks.filter((w) => w.open > 0);
  return (live.length ? live : weeks)[live.length ? live.length - 1 : weeks.length - 1].week;
}

/**
 * Every open bet in the league, with the pick withheld.
 *
 * You see who bet, how much, at what price, and what it would return. You never
 * see which market or which side -- that is the whole point. Enough to judge
 * whether a bet is worth attacking; nothing you could copy.
 *
 * The withholding is structural: `attackableBets` does not join markets at all,
 * so there is no column here that could leak a pick if the UI forgot to strip
 * one.
 */
export default async function ActionPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see the action.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  const WEEK = await currentWeek();
  const [bets, inventory, bounties, managers, points] = await Promise.all([
    attackableBets(SEASON, WEEK),
    guest ? [] : getInventory(slug, SEASON),
    openBounties(SEASON, WEEK),
    listBettors(),
    guest ? 0 : getPoints(slug, SEASON),
  ]);

  // Bounties name a weapon, so the board needs the boost's display name.
  const named = bounties.map((b) => ({
    ...b,
    weaponName: byKind[b.weapon]?.name ?? b.weapon,
  }));
  // Keyed by BET, not by bettor: a bounty names one bet, so only that bet
  // should wear the pill. Keyed by person it marked every bet they had.
  const bountyByBet = {};
  for (const b of named) {
    if (b.bet_id != null) (bountyByBet[String(b.bet_id)] ??= []).push(b);
  }

  // Attacks you own and could fire right now.
  const attacks = inventory
    .map((b) => ({ ...b, def: byKind[b.kind] }))
    .filter((b) => b.def?.attack && b.def.target === 'bet');

  // Every attack that exists, so the popup can show what you COULD buy rather
  // than rendering nothing. Hiding the button when you own none made the page
  // look like it had no actions at all.
  const catalogue = BOOSTS.filter((b) => b.attack && b.target === 'bet').map((b) => ({
    kind: b.kind,
    name: b.name,
    icon: b.icon,
    blurb: b.blurb,
    cost: b.cost,
  }));

  // A bounty can name ANY attack, including the two that hit a person rather
  // than a bet -- the attack popup only offers the bet-targeted ones.
  const bountyWeapons = BOOSTS.filter((b) => b.attack).map((b) => ({
    kind: b.kind,
    name: b.name,
    icon: b.icon,
    blurb: b.blurb,
    cost: b.cost,
    target: b.target,
  }));
  // What it costs to start each one, worked out server-side so the form and the
  // server cannot disagree about the 20%.
  const stakes = Object.fromEntries(bountyWeapons.map((b) => [b.kind, minimumStake(b.cost)]));

  // The picker needs something to call each bet. Same withholding as the list
  // below -- stake and price, never the pick.
  // Bets a bounty could actually land on. One already hit cannot take another
  // attack, and an insured one would absorb it -- funding either is throwing
  // points away, so they are not offered.
  const pickable = bets
    .filter((b) => Number(b.attacked ?? 0) === 0 && Number(b.shielded ?? 0) === 0)
    .map((b) => ({
    id: String(b.id),
    bettor: b.bettor,
    bettor_name: b.bettor_name,
    shielded: Number(b.shielded ?? 0),
    label: b.is_parlay
      ? `${b.leg_count}-leg parlay · ${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`
      : `${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`,
  }));

  // Labels cover every bet, not just the pickable ones -- a bounty posted
  // before its bet was attacked still needs a name on its card.
  const betLabels = Object.fromEntries(
    bets.map((b) => [
      String(b.id),
      b.is_parlay
        ? `${b.leg_count}-leg parlay · ${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`
        : `${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`,
    ]),
  );
  const namedWithBets = named.map((b) => ({
    ...b,
    betLabel: b.bet_id != null ? betLabels[String(b.bet_id)] ?? null : null,
  }));

  const mine = bets.filter((b) => b.bettor === slug);
  const theirs = bets.filter((b) => b.bettor !== slug);

  return (
    <>
      <p className="page-sub">
        Every open bet in the league. You can see the money, never the pick.
      </p>

      <section className="section">
        <p className="note" style={{ padding: '0 2px 12px' }}>
          Attacks are blind. A big bet at long odds is obviously worth hitting — but you have
          no idea whether it is going to land, and hitting a loser does nothing at all. That
          is why they are cheap.
        </p>
        {!guest && attacks.length > 0 && (
          <div className="attack-arsenal">
            {attacks.map((a) => (
              <span key={a.id} className="pill teal">
                {a.def.icon} {a.def.name}
              </span>
            ))}
          </div>
        )}
      </section>

      {namedWithBets.length > 0 && (
        <section className="section">
          <a className="bounty-teaser" href="/book/bounties">
            🎯 <strong>{namedWithBets.length}</strong>{' '}
            {namedWithBets.length === 1 ? 'bounty' : 'bounties'} open — chip in on the
            Bounties tab
          </a>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Open bets</h2>
          <span className="dim">{bets.length} live</span>
        </div>

        {bets.length === 0 ? (
          <div className="empty">Nothing has been bet yet this week.</div>
        ) : (
          <div className="rows">
            {[...theirs, ...mine].map((b) => {
              const stake = Number(b.stake_cents);
              const returns = payoutCents(stake, b.odds);
              const isMine = b.bettor === slug;
              return (
                <div key={b.id} className={`row ${isMine ? 'row-me' : ''}`}>
                  <span className="row-main">
                    <span className="row-name">
                      {b.bettor_name}
                      {b.is_parlay && (
                        <span className="dim"> · {b.leg_count}-leg parlay</span>
                      )}
                      {(bountyByBet[String(b.id)] ?? []).map((x) => (
                        <span key={x.id} className="pill bounty-pill" style={{ marginLeft: 6 }}>
                          🎯 {x.raised}/{x.cost_points}
                        </span>
                      ))}
                      {b.shielded > 0 && <span className="pill" style={{ marginLeft: 6 }}>🛡️</span>}
                      {b.attacked > 0 && <span className="pill" style={{ marginLeft: 4 }}>🎯</span>}
                    </span>
                    <span className="dim">
                      {formatMoney(stake)} at {formatOdds(b.odds)} · returns{' '}
                      {formatMoney(returns)}
                    </span>
                  </span>
                  {!guest && !isMine && (
                    <AttackButton
                      betId={String(b.id)}
                      who={b.bettor_name}
                      shielded={b.shielded > 0}
                      catalogue={catalogue}
                      attacks={attacks.map((a) => ({
                        id: String(a.id),
                        kind: a.kind,
                        name: a.def.name,
                        icon: a.def.icon,
                        blurb: a.def.blurb,
                      }))}
                    />
                  )}
                  {isMine && <span className="row-value dim">yours</span>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
