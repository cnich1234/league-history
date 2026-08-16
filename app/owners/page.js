import { getOwners } from '@/lib/data';
import RankRow from '@/components/RankRow';

export const metadata = { title: 'Managers' };

export default function OwnersPage() {
  const owners = [...getOwners()].sort(
    (a, b) => b.winPct - a.winPct || b.wins - a.wins
  );

  return (
    <>
      <header className="page-head">
        <h1>Managers</h1>
        <div className="sub">All-time, sorted by win percentage</div>
      </header>

      <div className="card rows">
        {owners.map((owner, index) => (
          <RankRow
            key={owner.slug}
            rank={index + 1}
            owner={owner}
            stat={`${owner.winPct}%`}
            detail={
              `${owner.wins}-${owner.losses}` +
              (owner.championships ? ` · ${'🏆'.repeat(owner.championships)}` : '') +
              ` · ${owner.seasonsPlayed} seasons`
            }
          />
        ))}
      </div>

      <div className="note">
        Records cover the regular season. Tap a manager for season-by-season
        detail, head-to-head, and personal records.
      </div>
    </>
  );
}
