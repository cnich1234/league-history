import Link from 'next/link';

import { getWeek, byId } from '@/lib/trophies';
import { getOwners } from '@/lib/data';

// Rendered on demand rather than prerendered. generateStaticParams used to read
// the scored weeks from a file at build time; from the database it would freeze
// whatever had been scored when the deploy happened, and a week scored by the
// cron would 404 until the next one.
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

export async function generateMetadata({ params }) {
  const { week } = await params;
  return { title: `Week ${week}` };
}

export default async function WeekPage({ params }) {
  const { week: weekParam } = await params;
  const week = await getWeek(SEASON, Number(weekParam));
  if (!week) {
    return (
      <main className="page">
        <Link href="/trophies" className="back">‹ Trophy Room</Link>
        <header className="page-head">
          <h1>Week {weekParam}</h1>
        </header>
        <section className="section">
          <div className="empty">This week has not been scored yet.</div>
        </section>
      </main>
    );
  }

  const nameBySlug = Object.fromEntries(getOwners().map((o) => [o.slug, o.name]));
  const name = (s) => nameBySlug[s] ?? s;

  // Group awards by manager so each person reads as one block.
  const byManager = {};
  for (const a of week.awards) (byManager[a.slug] ??= []).push(a);
  const ranked = Object.entries(byManager).sort(
    (x, y) => (week.totals[y[0]] ?? 0) - (week.totals[x[0]] ?? 0),
  );

  return (
    <main className="page">
      <Link href="/trophies" className="back">
        ‹ Trophy Room
      </Link>
      <header className="page-head">
        <h1>Week {week.week}</h1>
        <p className="dim">
          Median {week.median} · won by {week.weekWinners.map(name).join(' & ')} with{' '}
          {week.weekWinnerPoints}
        </p>
      </header>

      <section className="section">
        <div className="section-head">
          <h2>Results</h2>
        </div>
        <div className="rows">
          {week.games.map((g, i) => (
            <div key={i} className="row">
              <span className="row-main">
                <span className="row-name">
                  {g.winnerName} def. {g.loserName}
                  {g.upset ? ' 🗡️' : ''}
                </span>
                <span className="dim">
                  {g.winnerPoints} – {g.loserPoints} · margin {g.margin}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Points This Week</h2>
        </div>
        {ranked.map(([slug, awards]) => (
          <div key={slug} className="award-block">
            <div className="award-head">
              <Link href={`/owner/${slug}`} className="award-name">
                {name(slug)}
              </Link>
              <span className={`award-total ${week.totals[slug] < 0 ? 'neg' : ''}`}>
                {week.totals[slug] > 0 ? `+${week.totals[slug]}` : week.totals[slug]}
              </span>
            </div>
            {awards.map((a, i) => {
              const def = byId[a.achievement];
              return (
                <div key={i} className="award-row">
                  <span className="guide-icon">{def?.icon ?? '•'}</span>
                  <span className="guide-main">
                    <span className="guide-name">{def?.name ?? a.achievement}</span>
                    <span className="dim">{a.detail}</span>
                  </span>
                  <span className={`guide-pts ${a.points < 0 ? 'neg' : ''}`}>
                    {a.points > 0 ? `+${a.points}` : a.points}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </section>
    </main>
  );
}
