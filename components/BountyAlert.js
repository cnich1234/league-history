/**
 * Open bounties, counted on the board.
 *
 * Two boxes and nothing else: how many are on YOU, and how many are on
 * everyone else. The details -- weapon, target, how funded -- live on the
 * Bounties tab, and both boxes go there. The board is for betting, and the
 * old list of three with a footer pushed the markets off a phone.
 *
 * Server component -- renders from data, no state of its own.
 */
export default function BountyAlert({ bounties = [], mine = null }) {
  if (bounties.length === 0) return null;
  const onMe = mine == null ? 0 : bounties.filter((b) => b.target === mine).length;
  const others = bounties.length - onMe;

  return (
    <section className="section bounty-counts">
      <a className={`bounty-count ${onMe > 0 ? 'bounty-count-you' : ''}`} href="/book/bounties">
        <span className="bounty-count-n">{onMe}</span>
        <span className="bounty-count-label">
          {onMe === 1 ? 'bounty on YOU' : 'bounties on YOU'}
        </span>
      </a>
      <a className="bounty-count" href="/book/bounties">
        <span className="bounty-count-n">{others}</span>
        <span className="bounty-count-label">
          {others === 1 ? 'bounty on everyone else' : 'bounties on everyone else'}
        </span>
      </a>
    </section>
  );
}
