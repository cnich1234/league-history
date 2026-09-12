import { currentBettor, isGuestSlug, listBettors } from '@/lib/auth';
import { attackableBets, currentWeek } from '@/lib/book';
import { openBounties, getPoints, minimumStake } from '@/lib/shop';
import { byKind, BOOSTS } from '@/lib/boosts';
import { formatMoney, formatOdds } from '@/lib/odds';
import BountyBoard from '@/components/BountyBoard';

export const metadata = { title: 'Bounties' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Bounties, on their own page.
 *
 * They started as a panel on The Action and pushed the open bets off the
 * screen: four of them filled a phone before a single bet was visible. They are
 * their own thing -- a crowd buying an attack rather than one person firing one
 * -- so they get their own tab, and The Action goes back to being a list of
 * bets with a pill where a bounty is riding on one.
 */
export default async function BountiesPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see the bounties.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  const week = await currentWeek(SEASON);
  const [bets, bounties, managers, points] = await Promise.all([
    attackableBets(SEASON, week),
    openBounties(SEASON, week),
    listBettors(),
    guest ? 0 : getPoints(slug, SEASON),
  ]);

  const named = bounties.map((b) => ({
    ...b,
    weaponName: byKind[b.weapon]?.name ?? b.weapon,
  }));

  // Any attack that hits a bet or a person. Poison hits a MARKET, which a
  // bounty has no way to name, so it is left off rather than offered broken.
  const weapons = BOOSTS.filter((b) => b.attack && b.target !== 'market').map((b) => ({
    kind: b.kind,
    name: b.name,
    icon: b.icon,
    blurb: b.blurb,
    cost: b.cost,
    target: b.target,
  }));
  const stakes = Object.fromEntries(weapons.map((b) => [b.kind, minimumStake(b.cost)]));

  const label = (b) =>
    b.is_parlay
      ? `${b.leg_count}-leg parlay · ${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`
      : `${formatMoney(Number(b.stake_cents))} at ${formatOdds(b.odds)}`;

  // Only bets a bounty could actually land on: one already hit cannot take
  // another attack, and an insured one would absorb it.
  const pickable = bets
    .filter((b) => Number(b.attacked ?? 0) === 0 && Number(b.shielded ?? 0) === 0)
    .map((b) => ({
      id: String(b.id),
      bettor: b.bettor,
      bettor_name: b.bettor_name,
      shielded: Number(b.shielded ?? 0),
      label: label(b),
    }));

  // Labels cover every bet, so a bounty posted before its bet was hit still
  // has a name on its card.
  const betLabels = Object.fromEntries(bets.map((b) => [String(b.id), label(b)]));
  const withBets = named.map((b) => ({
    ...b,
    betLabel: b.bet_id != null ? (betLabels[String(b.bet_id)] ?? null) : null,
  }));

  return (
    <>
      <p className="page-sub">
        Put points on someone&apos;s head. Anybody can chip in — when it fills, the attack
        fires by itself.
      </p>

      <section className="section">
        <p className="note" style={{ padding: '0 2px 12px' }}>
          A bounty costs exactly what the attack costs in the Store, so nobody profits
          from one. What it buys is <strong>reach</strong>: a 12-point Void is two and a
          half weeks of allowance on your own, or two points each if six people agree it
          should happen.
        </p>
      </section>

      {guest ? (
        <section className="section">
          <div className="section-head">
            <h2>Bounties</h2>
            <span className="dim">{withBets.length} open</span>
          </div>
          {withBets.length === 0 ? (
            <div className="empty">Nothing is out on anybody.</div>
          ) : (
            <div className="bounty-list">
              {withBets.map((b) => (
                <div key={b.id} className="bounty-alert">
                  <div className="bounty-head">BOUNTY ALERT</div>
                  <div className="bounty-body">
                    A bounty on <strong>{b.target_name.toUpperCase()}</strong>
                    <br />
                    <span className="dim">ATTACK:</span> <strong>{b.weaponName}</strong>
                  </div>
                  <div className="bounty-bar">
                    <div
                      className="bounty-bar-fill"
                      style={{
                        width: `${Math.min(100, Math.round((b.raised / b.cost_points) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="bounty-bar-text">
                    <strong className="bounty-reward">
                      {b.raised} / {b.cost_points}
                    </strong>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <BountyBoard
          bounties={withBets}
          bets={pickable}
          managers={managers}
          attacks={weapons}
          points={points}
          week={week}
          me={slug}
          stakes={stakes}
        />
      )}
    </>
  );
}
