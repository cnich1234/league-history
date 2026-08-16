import Link from 'next/link';

const MEDAL = ['gold', 'silver', 'bronze'];

/** One tappable leaderboard row linking through to the owner's page. */
export default function RankRow({ rank, owner, stat, detail, statClass = '' }) {
  return (
    <Link href={`/owner/${owner.slug}`} className="row">
      <span className={`rank ${MEDAL[rank - 1] ?? ''}`}>{rank}</span>
      <span className="who">
        <span className="name">{owner.name}</span>
        {detail && <span className="detail">{detail}</span>}
      </span>
      <span className={`stat ${statClass}`}>{stat}</span>
      <span className="chev">›</span>
    </Link>
  );
}
