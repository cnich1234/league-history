import { currentBettor, isGuestSlug } from '@/lib/auth';
import { attackableBets, currentWeek, phasesForBets, standingForBets } from '@/lib/book';
import { getInventory, openBounties, getPoints, minimumStake } from '@/lib/shop';
import { listBettors } from '@/lib/auth';
import { byKind, BOOSTS } from '@/lib/boosts';
import { formatMoney, formatOdds, payoutCents } from '@/lib/odds';
import AttackButton from '@/components/AttackButton';

export const metadata = { title: 'The Action' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

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
  const WEEK = await currentWeek(SEASON);
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

  // Ride Along is not an attack, but it is aimed at somebody else's bet, and
  // this is the only page that lists those. It had no way to be used at all:
  // the generic target picker refuses anything aimed at another person's bet.
  const rides = inventory
    .map((b) => ({ ...b, def: byKind[b.kind] }))
    .filter((b) => b.def?.copies);

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
      ? `${b.leg_count}-leg parlay · ${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)} · +${formatMoney(payoutCents(Number(b.stake_cents), b.odds) - Number(b.stake_cents))} to win`
      : `${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)} · +${formatMoney(payoutCents(Number(b.stake_cents), b.odds) - Number(b.stake_cents))} to win`,
  }));

  // Labels cover every bet, not just the pickable ones -- a bounty posted
  // before its bet was attacked still needs a name on its card.
  const betLabels = Object.fromEntries(
    bets.map((b) => [
      String(b.id),
      b.is_parlay
        ? `${b.leg_count}-leg parlay · ${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)} · +${formatMoney(payoutCents(Number(b.stake_cents), b.odds) - Number(b.stake_cents))} to win`
        : `${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)} · +${formatMoney(payoutCents(Number(b.stake_cents), b.odds) - Number(b.stake_cents))} to win`,
    ]),
  );
  const namedWithBets = named.map((b) => ({
    ...b,
    betLabel: b.bet_id != null ? betLabels[String(b.bet_id)] ?? null : null,
  }));

  // Where each bet's game stands. Read from Sleeper's game state on the
  // server; only the word reaches the page. This is what decides whether a
  // bet can be attacked at all -- a finished game cannot -- and whether it
  // can still be copied, which only an unstarted one can.
  const phases = await phasesForBets(bets.map((b) => b.id));

  // How the CLOSED bets would settle. Only the closed ones: a live bet's
  // standing result would be a spoiler, and an open one has no result at all.
  // Settlement runs Tuesday and the last game ends Monday night, so without
  // this the page spends a day saying "Closed" about bets whose outcome
  // everybody watching already knows.
  const closedIds = bets.filter((b) => (phases[Number(b.id)] ?? 'open') === 'closed').map((b) => b.id);
  const standing = closedIds.length ? await standingForBets(closedIds).catch(() => ({})) : {};
  const grouped = { open: [], live: [], locked: [], closed: [] };
  // Other people's bets first within a group, yours at the bottom.
  for (const b of [...bets.filter((b) => b.bettor !== slug), ...bets.filter((b) => b.bettor === slug)]) {
    (grouped[phases[Number(b.id)] ?? 'open'] ??= []).push(b);
  }
  const STANDING_LABEL = {
    won: 'Won',
    lost: 'Lost',
    push: 'Push',
    void: 'Void',
  };
  const GROUPS = [
    ['open', 'Open bets', 'games not started'],
    ['live', 'Live bets', 'prices moving'],
    ['locked', 'Locked bets', 'bets closed, games in play'],
    ['closed', 'Closed bets', 'games over, waiting on settlement'],
  ];

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

      {bets.length === 0 && (
        <section className="section">
          <div className="empty">Nothing has been bet yet this week.</div>
        </section>
      )}

      {GROUPS.map(([phase, title, note]) => {
        const rows = grouped[phase];
        if (!rows.length) return null;
        return (
          <section className="section" key={phase}>
            <div className="section-head">
              <h2>{title}</h2>
              <span className="dim">
                {rows.length} · {note}
              </span>
            </div>
            {byOwner(rows, slug).map(({ bettor, name, bets: mine, staked, toWin, isYou }) => (
              <details
                key={bettor}
                className="act-owner"
                // Your own bets open; everyone else's folded, since the page is
                // for scanning who is exposed rather than reading every line.
                // One manager with eleven bets used to push everybody else off
                // the screen.
                open={isYou}
              >
                <summary className="act-owner-head">
                  <span className="act-owner-main">
                    <span className="act-owner-name">
                      {name}
                      {isYou && <span className="dim"> · you</span>}
                    </span>
                    <span className="dim">
                      {mine.length} {mine.length === 1 ? 'bet' : 'bets'} ·{' '}
                      {formatMoney(staked)} staked ·{' '}
                      <span className="pos">+{formatMoney(toWin)}</span> to win
                    </span>
                  </span>
                  <span className="act-owner-chevron" aria-hidden="true" />
                </summary>
            <div className="rows">
              {mine.map((b) => {
                const stake = Number(b.stake_cents);
                const returns = payoutCents(stake, b.odds);
                // What a win actually banks. The stake is consumed either way,
                // so the return overstates the gain by the stake -- and on this
                // page the profit is also what an attacker is aiming at.
                const profit = returns - stake;
                const isMine = b.bettor === slug;
                return (
                  <div
                    key={b.id}
                    className={[
                      'row',
                      isMine ? 'row-me' : '',
                      // Order matters: a hit bet is done with, whatever else is
                      // true of it, so that wins over the other two.
                      b.attacked > 0
                        ? 'row-hit'
                        : b.shielded > 0
                          ? 'row-shielded'
                          : (bountyByBet[String(b.id)] ?? []).length
                            ? 'row-bountied'
                            : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
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
                        {formatMoney(stake)} at {formatOdds(b.odds)} ·{' '}
                        <span className="pos">+{formatMoney(profit)}</span> to win
                      </span>
                    </span>
                    {!guest && !isMine && phase !== 'closed' && (
                      <AttackButton
                        betId={String(b.id)}
                        who={b.bettor_name}
                        shielded={b.shielded > 0}
                        // One attack per bet, so a bet that has taken one cannot
                        // take another. Offering the button anyway just produces
                        // a rejection after two taps.
                        spent={b.attacked > 0}
                        catalogue={catalogue}
                        attacks={attacks.map((a) => ({
                          id: String(a.id),
                          kind: a.kind,
                          name: a.def.name,
                          icon: a.def.icon,
                          blurb: a.def.blurb,
                        }))}
                        rides={rides.map((r) => ({
                          id: String(r.id),
                          kind: r.kind,
                          name: r.def.name,
                          icon: r.def.icon,
                          blurb: r.def.blurb,
                        }))}
                        stakeCents={stake}
                        // A copy is only honest before kickoff.
                        rideable={phase === 'open' && !b.is_parlay}
                      />
                    )}
                    {phase === 'closed' && (
                      /* The games are over but settlement runs on Tuesday, so
                         for a day this said only "Closed" about bets whose
                         result everybody watching already knew. Projected from
                         the same scores and the same resolver settlement uses,
                         so it cannot disagree with the money when it lands. */
                      <span
                        className={`act-standing act-standing-${standing[Number(b.id)] ?? 'unknown'}`}
                        title={
                          standing[Number(b.id)]
                            ? 'Final, pending settlement on Tuesday'
                            : 'The game is over; the result is not in yet'
                        }
                      >
                        {STANDING_LABEL[standing[Number(b.id)]] ?? 'Closed'}
                      </span>
                    )}
                    {isMine && <span className="row-value dim">yours</span>}
                  </div>
                );
              })}
            </div>
              </details>
            ))}
          </section>
        );
      })}
    </>
  );
}

/**
 * Bets grouped by who placed them, with each owner's totals.
 *
 * Sorted by money at stake, so whoever is most exposed reads first -- which is
 * what an attacker is looking for. Yours goes last regardless, the same order
 * the ungrouped list used.
 */
function byOwner(rows, slug) {
  const groups = new Map();
  for (const b of rows) {
    const key = b.bettor;
    if (!groups.has(key)) {
      groups.set(key, {
        bettor: key,
        name: b.bettor_name,
        isYou: key === slug,
        bets: [],
        staked: 0,
        toWin: 0,
      });
    }
    const g = groups.get(key);
    const stake = Number(b.stake_cents);
    g.bets.push(b);
    g.staked += stake;
    g.toWin += payoutCents(stake, b.odds) - stake;
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.isYou) - Number(b.isYou) || b.staked - a.staked,
  );
}
