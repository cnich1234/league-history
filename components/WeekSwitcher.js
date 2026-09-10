/**
 * Week navigation for the board.
 *
 * The page has always read `?week=` but nothing ever set it, so every week
 * except the default was unreachable without hand-editing the URL. Week 2's
 * markets existed and no one in the league could see them.
 *
 * Plain links rather than a client component: this is navigation, it works
 * without JS, and each week is a real URL someone can send to the group chat.
 */
export default function WeekSwitcher({ weeks, current }) {
  // One week is not a choice worth showing.
  if (!weeks || weeks.length < 2) return null;

  return (
    <nav className="week-switch" aria-label="Week">
      {weeks.map((w) => (
        <a
          key={w.week}
          href={`/book?week=${w.week}`}
          className={`week-chip ${w.week === current ? 'week-chip-on' : ''}`}
          aria-current={w.week === current ? 'page' : undefined}
        >
          Week {w.week}
          {w.open > 0 && <span className="week-chip-count">{w.open}</span>}
        </a>
      ))}
    </nav>
  );
}
