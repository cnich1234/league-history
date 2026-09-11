import { currentBettor, isGuestSlug } from '@/lib/auth';
import { attackableBets } from '@/lib/book';
import { getInventory } from '@/lib/shop';
import { byKind, BOOSTS } from '@/lib/boosts';
import { formatMoney, formatOdds, payoutCents } from '@/lib/odds';
import AttackButton from '@/components/AttackButton';

export const metadata = { title: 'The Action' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const WEEK = Number(process.env.BOOK_WEEK ?? 1);

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
  const [bets, inventory] = await Promise.all([
    attackableBets(SEASON, WEEK),
    guest ? [] : getInventory(slug, SEASON),
  ]);

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
