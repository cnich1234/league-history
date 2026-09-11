import Link from 'next/link';
import { getWeekly, byId, ACHIEVEMENTS } from '@/lib/weekly';
import { getOwners } from '@/lib/data';
import { SLEEPER_OWNERS } from '@/scripts/sleeper-owners.mjs';
import LiveSection from '@/components/LiveSection';

export const metadata = { title: 'Trophy Room' };

export default function TrophiesPage() {
  const { weeks, season = [] } = getWeekly();
  const nameBySlug = Object.fromEntries(getOwners().map((o) => [o.slug, o.name]));
  const latest = weeks[weeks.length - 1] ?? null;

  if (!weeks.length) {
    return (
      <main className="page">
        <header className="page-head">
          <h1>Trophy Room</h1>
          <p className="dim">Weekly achievements. Points buy boosts in The Book.</p>
        </header>
        <section className="section">
          <div className="section-head">
            <h2>Live</h2>
          </div>
          <LiveSection owners={SLEEPER_OWNERS} />
        </section>
        <ScoringGuide />
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-head">
        <h1>Trophy Room</h1>
        <p className="dim">
          {weeks.length} week{weeks.length === 1 ? '' : 's'} scored · points earned
        </p>
      </header>

      <section className="section">
        <div className="section-head">
          <h2>Live</h2>
        </div>
        <LiveSection owners={SLEEPER_OWNERS} />
      </section>

      {latest && (
        <section className="section">
          <div className="section-head">
            <h2>Week {latest.week} Winner</h2>
            <Link className="chev" href={`/trophies/${latest.week}`}>
              full week →
            </Link>
          </div>
          <div className="winner-card">
            <div className="winner-names">
              {latest.weekWinners.map((s) => nameBySlug[s] ?? s).join(' & ')}
            </div>
            <div className="winner-points">{latest.weekWinnerPoints} pts</div>
          </div>
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>Points Earned</h2>
          {/* Total earned all season, not what is left to spend -- the Store
              tab holds the balance, which goes down as boosts are bought. */}
          <span className="dim">all season · spend them in The Book</span>
        </div>
        <div className="rows">
          {season.map((s, i) => (
            <Link key={s.slug} href={`/owner/${s.slug}`} className="row">
              <span className="rank">{i + 1}</span>
              <span className="row-main">
                <span className="row-name">{nameBySlug[s.slug] ?? s.slug}</span>
                <span className="dim">
                  {s.weeksWon > 0 ? `${s.weeksWon} week${s.weeksWon === 1 ? '' : 's'} won · ` : ''}
                  {topBadges(s.badges)}
                </span>
              </span>
              <span className={`row-value ${s.points < 0 ? 'neg' : ''}`}>{s.points}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>By Week</h2>
        </div>
        <div className="rows">
          {[...weeks].reverse().map((w) => (
            <Link key={w.week} href={`/trophies/${w.week}`} className="row">
              <span className="row-main">
                <span className="row-name">Week {w.week}</span>
                <span className="dim">
                  {w.weekWinners.map((s) => nameBySlug[s] ?? s).join(' & ')} · {w.awards.length} awards
                </span>
              </span>
              <span className="chev">→</span>
            </Link>
          ))}
        </div>
      </section>

      <ScoringGuide />
    </main>
  );
}

/** Up to three most-earned badges, so the standings row says how, not just how many. */
function topBadges(badges = {}) {
  return Object.entries(badges)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, n]) => `${byId[id]?.icon ?? ''}${n > 1 ? `×${n}` : ''}`)
    .join(' ');
}

function ScoringGuide() {
  const groups = [
    ['Earn points', 'good'],
    ['Bonus', 'bonus'],
    // Was "Pain", when these docked you points. Nothing here takes anything
    // away any more -- the category pays consolation instead.
    ['Rough week', 'pain'],
  ];
  return (
    <section className="section">
      <div className="section-head">
        <h2>How Points Work</h2>
      </div>

      <p className="note" style={{ padding: '0 2px 12px' }}>
        Points are currency. They buy <strong>boosts</strong> in The Book — insurance on a
        bet, a better price, or something nastier aimed at everyone else. You also get{' '}
        <strong>5 a week</strong> regardless, so trophies are roughly half of what you have
        to spend.
      </p>
      <p className="note" style={{ padding: '0 2px 14px' }}>
        Nothing here costs you points. Scoring the least in the league pays 2, and there
        are four awards you can win while losing — a rough season on the field should not
        lock you out of the store.
      </p>
      {groups.map(([label, cat]) => (
        <div key={cat} className="guide-group">
          <div className="guide-label">{label}</div>
          {ACHIEVEMENTS.filter((a) => a.category === cat).map((a) => (
            <div key={a.id} className="guide-row">
              <span className="guide-icon">{a.icon}</span>
              <span className="guide-main">
                <span className="guide-name">{a.name}</span>
                <span className="dim">{a.blurb}</span>
              </span>
              <span className={`guide-pts ${a.points < 0 ? 'neg' : ''}`}>
                {a.points > 0 ? `+${a.points}` : a.points}
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
