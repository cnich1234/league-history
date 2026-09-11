/**
 * Open bounties, announced on the board.
 *
 * The full board -- with the form to start one and the buttons to fund one --
 * lives on The Action. This is the announcement only, because the board is
 * where people actually are, and a bounty nobody sees is a bounty nobody
 * funds.
 *
 * The whole value of a bounty is that it is public: the target knows to buy
 * Insurance, and everyone else knows there are points on the table. Keeping it
 * one tab away worked against that.
 *
 * Server component -- renders from data, no state of its own.
 */
export default function BountyAlert({ bounties = [], mine = null }) {
  if (bounties.length === 0) return null;
  // The board is for betting. Five of these pushed the markets off a phone, so
  // it shows the three closest to firing and links to the rest.
  const shown = bounties.slice(0, 3);
  const hidden = bounties.length - shown.length;

  return (
    <section className="section">
      <a className="bounty-alert bounty-alert-compact" href="/book/bounties">
        <div className="bounty-head">
          BOUNTY ALERT
          {bounties.length > 1 && <span className="dim"> · {bounties.length} open</span>}
        </div>
        <ul className="bounty-alert-list">
          {shown.map((b) => {
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
                  — <strong>{b.weaponName}</strong>,{' '}
                  <strong className="bounty-reward">
                    {b.raised}/{b.cost_points}
                  </strong>{' '}
                  funded.{' '}
                  <span className="dim">{b.remaining} to go.</span>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="dim bounty-alert-foot">
          {hidden > 0 && <>and {hidden} more. </>}
          Fund one on the <strong>Bounties</strong> tab — when it fills, the attack fires.
        </div>
      </a>
    </section>
  );
}
