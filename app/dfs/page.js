import { currentBettor, isGuestSlug } from '@/lib/auth';
import { weeksWithMarkets } from '@/lib/book';
import {
  salaryPool,
  weeklyContest,
  myEntry,
  openLobbies,
  LINEUP,
  FLEX_POSITIONS,
  SALARY_CAP,
  PLACE_POINTS,
} from '@/lib/dfs';
import { getPoints } from '@/lib/shop';
import LineupBuilder from '@/components/LineupBuilder';
import LobbyList from '@/components/LobbyList';

export const metadata = { title: 'Daily' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/** The week people are playing: the latest with open markets. */
async function currentWeek() {
  const weeks = await weeksWithMarkets(SEASON);
  if (!weeks.length) return Number(process.env.BOOK_WEEK ?? 1);
  const live = weeks.filter((w) => w.open > 0);
  const list = live.length ? live : weeks;
  return list[list.length - 1].week;
}

/**
 * Daily fantasy: the weekly contest.
 *
 * One game a week, everybody in, no buy-in. Where you finish mints points that
 * spend in the same shop as trophies and the allowance.
 */
export default async function DailyPage() {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to play.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  const week = await currentWeek();
  const pool = await salaryPool(SEASON, week);

  if (!pool.length) {
    return (
      <>
        <p className="page-sub">One game a week. Everyone in. Finish well, earn points.</p>
        <section className="section">
          <div className="empty">
            Week {week} has not been priced yet. Salaries are built when the board is.
          </div>
        </section>
      </>
    );
  }

  const contest = await weeklyContest(SEASON, week);
  const [entry, lobbies, points] = await Promise.all([
    guest ? null : myEntry(slug, contest.id),
    openLobbies(SEASON, week),
    guest ? 0 : getPoints(slug, SEASON),
  ]);

  // Which lobbies you are already sitting in, so the list can say so.
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  const mine = guest
    ? []
    : (
        await sql`
          select contest_id from dfs_entries
          where bettor = ${slug} and season = ${SEASON} and week = ${week}`
      ).map((r) => String(r.contest_id));
  const withMine = lobbies.map((l) => ({ ...l, entered: mine.includes(String(l.id)) }));

  return (
    <>
      <p className="page-sub">
        One game a week, everyone in. Build a lineup under the cap; where you finish pays
        points into the same bank the shop spends from.
      </p>

      <section className="section">
        <div className="section-head">
          <h2>Week {week}</h2>
          <span className="dim">{pool.length} players</span>
        </div>
        <p className="note" style={{ padding: '0 2px 10px' }}>
          Salaries come from Sleeper&apos;s own projections, so a player they rate low is
          cheap whether or not he deserves to be — which is the whole game. First place
          pays <strong>{PLACE_POINTS[0]}</strong>, down to nothing for last.
        </p>
      </section>

      {guest ? (
        <section className="section">
          <div className="empty">Guests can look, but not enter.</div>
        </section>
      ) : (
        <LineupBuilder
          contestId={String(contest.id)}
          week={week}
          lineup={LINEUP}
          flexPositions={FLEX_POSITIONS}
          cap={SALARY_CAP}
          pool={pool}
          initialSlots={entry?.slots ?? null}
          readOnly={contest.status !== 'open'}
        />
      )}

      {!guest && (
        <LobbyList
          lobbies={withMine}
          week={week}
          points={points}
          me={slug}
          cap={SALARY_CAP}
        />
      )}
    </>
  );
}
