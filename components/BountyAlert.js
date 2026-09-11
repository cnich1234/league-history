/**
 * Open bounties, announced on the board.
 *
 * The full board -- with the form to post one -- lives on The Action. This is
 * the announcement only, because the board is where people actually are, and a
 * bounty nobody sees is a bounty nobody collects.
 *
 * The whole value of a bounty is that it is public: the target knows to buy
 * Insurance, and everyone else knows there are points on the table. Keeping it
 * one tab away worked against that.
 *
 * Server component -- renders from data, no state of its own.
 */
export default function BountyAlert({ bounties = [], mine = null }) {
  if (bounties.length === 0) return null;

  return (
    <section className="section">
      <div className="bounty-alert bounty-alert-compact">
        <div className="bounty-head">
          BOUNTY ALERT
          {bounties.length > 1 && <span className="dim"> · {bounties.length} open</span>}
        </div>
        <ul className="bounty-alert-list">
          {bounties.map((b) => {
            // Being the target is the one case where this is not gossip but a
            // warning, so say so rather than making them match their own name.
            const onMe = mine != null && b.target === mine;
            return (
              <li key={b.id}>
                <span className="bounty-icon" aria-hidden="true">
                  🎯
                </span>
                <span>
                  {onMe ? (
                    <strong className="bounty-on-you">There is a bounty on YOU</strong>
                  ) : (
                    <>
                      A bounty on <strong>{b.target_name.toUpperCase()}</strong>
                    </>
                  )}{' '}
                  — <strong>{b.weaponName}</strong> pays{' '}
                  <strong className="bounty-reward">{b.reward_points} points</strong>.{' '}
                  <span className="dim">Posted by {b.poster_name}.</span>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="dim bounty-alert-foot">
          Collect it on <strong>The Action</strong> — only that exact attack pays.
        </div>
      </div>
    </section>
  );
}
