import { currentBettor, isGuestSlug } from '@/lib/auth';
import { getPoints, getPointBalances, getInventory, getPointHistory } from '@/lib/shop';
import { BOOSTS, WEEKLY_ALLOWANCE, groupedBoosts } from '@/lib/boosts';
import BuyButton from '@/components/BuyButton';

export const metadata = { title: 'Store' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export default async function StorePage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see the store.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  const [points, balances, inventory, history] = await Promise.all([
    guest ? 0 : getPoints(slug, SEASON),
    getPointBalances(SEASON),
    guest ? [] : getInventory(slug, SEASON),
    guest ? [] : getPointHistory(slug, 12),
  ]);

  // How many of each kind are already sitting unused, so the shop can say so
  // rather than letting someone buy a fourth Insurance by accident.
  const ownedByKind = {};
  for (const b of inventory) ownedByKind[b.kind] = (ownedByKind[b.kind] ?? 0) + 1;

  return (
    <>
      <p className="page-sub">Trophy points buy boosts. Boosts change the money.</p>

      <section className="section">
        <div className={guest ? 'guest-card' : 'points-card'}>
          <div>
            <div className="dim">{guest ? 'Watching as a guest' : 'Your points'}</div>
            <div className="points-amount">{guest ? '—' : points}</div>
          </div>
          <div className="dim" style={{ textAlign: 'right', fontSize: 12.5 }}>
            {WEEKLY_ALLOWANCE} a week, plus
            <br />
            whatever the Trophy Room pays
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>The store</h2>
          <span className="dim">{BOOSTS.length} boosts</span>
        </div>

        {groupedBoosts().map((group) => (
          <div key={group.key} className="shop-group">
            <div className="shop-group-head">
              <h3>{group.title}</h3>
              <p className="dim">{group.blurb}</p>
            </div>
            <div className="shop-grid">
              {group.items.map((b) => {
                const owned = ownedByKind[b.kind] ?? 0;
                return (
              <div key={b.kind} className={`shop-item ${b.comingSoon ? 'shop-item-soon' : ''}`}>
                <div className="shop-head">
                  <span className="shop-icon" aria-hidden="true">
                    {b.icon}
                  </span>
                  <span className="shop-name">{b.name}</span>
                  <span className={`shop-cost ${!guest && points < b.cost ? 'shop-cost-short' : ''}`}>
                    {b.cost}
                  </span>
                </div>
                <p className="shop-blurb">{b.blurb}</p>
                <p className="shop-detail">{b.detail}</p>
                <div className="shop-foot">
                  {owned > 0 && <span className="pill teal">{owned} in stock</span>}
                  {b.comingSoon ? (
                    <span className="shop-soon">Coming soon</span>
                  ) : (
                    !guest && <BuyButton kind={b.kind} cost={b.cost} points={points} />
                  )}
                </div>
              </div>
                );
              })}
            </div>
            {/* A bounty is not a boost, so it is not for sale here -- but this
                is where someone shopping for an attack will look for it. */}
            {group.key === 'attack' && (
              <p className="shop-aside">
                🎯 You can also put points on someone&apos;s head — name a target, name the
                attack, and whoever lands it collects. That lives on{' '}
                <strong>The Action</strong>, not here: a bounty buys you nothing, it pays
                somebody else to do it.
              </p>
            )}
          </div>
        ))}
      </section>

      {!guest && history.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Where your points went</h2>
          </div>
          <div className="rows">
            {history.map((h) => (
              <div key={h.id} className="row">
                <span className="row-main">
                  <span className="row-name">{h.note ?? h.reason}</span>
                  <span className="dim">
                    {h.reason}
                    {h.week != null && ` · week ${h.week}`}
                  </span>
                </span>
                <span className={`row-value ${h.amount > 0 ? 'pos' : 'neg'}`}>
                  {h.amount > 0 ? `+${h.amount}` : h.amount}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Points table</h2>
          <span className="dim">this season</span>
        </div>
        <div className="rows">
          {balances.map((b, i) => (
            <div key={b.slug} className={`row ${b.slug === slug ? 'row-me' : ''}`}>
              <span className="rank">{i + 1}</span>
              <span className="row-main">
                <span className="row-name">{b.display_name}</span>
              </span>
              <span className="row-value">{b.points}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
