import Link from 'next/link';
import { getWriteups } from '@/lib/content';

export const metadata = { title: 'Writeups' };

const LABEL = { draft: 'Draft Recap', preview: 'Preview', recap: 'Recap' };
const ICON = { draft: '📋', preview: '🔮', recap: '📰' };

export default function WriteupsPage() {
  const writeups = getWriteups();

  return (
    <main className="page">
      <header className="page-head">
        <h1>Writeups</h1>
        <p className="dim">Weekly previews and recaps.</p>
      </header>

      <section className="section">
        {writeups.length === 0 ? (
          <div className="empty">Nothing posted yet.</div>
        ) : (
          <div className="rows">
            {writeups.map((w) => (
              <Link key={w.slug} href={`/writeups/${w.slug}`} className="row">
                <span className="guide-icon">{ICON[w.type]}</span>
                <span className="row-main">
                  <span className="row-name">
                    {w.type === 'draft' ? 'Draft Recap' : `Week ${w.week} ${LABEL[w.type]}`}
                  </span>
                  <span className="dim">{w.wordCount} words</span>
                </span>
                <span className="chev">→</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
