import { currentBettor, isGuestSlug } from '@/lib/auth';
import { getBoostHistory, getInventory } from '@/lib/shop';
import { byKind } from '@/lib/boosts';
import UseBoost from '@/components/UseBoost';

export const metadata = { title: 'My Boosts' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const WEEK = Number(process.env.BOOK_WEEK ?? 1);

export default async function BoostsPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to see your boosts.</div>
      </section>
    );
  }

  if (isGuestSlug(slug)) {
    return (
      <section className="section">
        <div className="empty">
          Guests do not own boosts. Sign in as yourself to buy and use them.
        </div>
      </section>
    );
  }

  const [inventory, history] = await Promise.all([
    getInventory(slug, SEASON),
    getBoostHistory(slug, SEASON),
  ]);

  const used = history.filter((b) => b.used_at);

  return (
    <>
      <p className="page-sub">What you own, and what you have already spent.</p>

      <section className="section">
        <div className="section-head">
          <h2>Ready to use</h2>
          <span className="dim">{inventory.length} in stock</span>
        </div>

        {inventory.length === 0 ? (
          <div className="empty">
            Nothing yet. The store is a tab away.
          </div>
        ) : (
          <div className="boost-list">
            {inventory.map((b) => {
              const def = byKind[b.kind];
              if (!def) return null;
              return (
                <div key={b.id} className="boost-card">
                  <span className="boost-icon" aria-hidden="true">
                    {def.icon}
                  </span>
                  <span className="boost-main">
                    <span className="boost-name">{def.name}</span>
                    <span className="dim">{def.blurb}</span>
                  </span>
                  {def.kind === 'odds-boost' ? (
                    // Chosen in the bet slip, not from here -- you pick it when
                    // placing a bet so you can see what it does to the price.
                    <span className="dim" style={{ fontSize: 12.5, textAlign: 'right' }}>
                      Use it on the board,
                      <br />
                      when you place a bet
                    </span>
                  ) : (
                  <UseBoost
                    boost={{
                      id: String(b.id),
                      kind: def.kind,
                      name: def.name,
                      icon: def.icon,
                      blurb: def.blurb,
                    }}
                    week={WEEK}
                  />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {used.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Already used</h2>
            <span className="dim">{used.length}</span>
          </div>
          <div className="rows">
            {used.map((b) => {
              const def = byKind[b.kind];
              return (
                <div key={b.id} className="row">
                  <span className="row-main">
                    <span className="row-name">
                      {def?.icon} {def?.name ?? b.kind}
                    </span>
                    <span className="dim">
                      {b.market_title
                        ? `on ${b.market_title}`
                        : b.target_name
                          ? `on ${b.target_name}`
                          : b.target_bet_id
                            ? 'on one of your bets'
                            : 'used'}
                    </span>
                  </span>
                  <span className="row-value dim">−{b.cost_points}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
