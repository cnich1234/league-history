import { currentBettor, isGuestSlug, listBettors } from '@/lib/auth';
import { currentWeek } from '@/lib/book';
import {
  salaryPool,
  weeklyContest,
  lineupFor,
  openLobbies,
  contestField,
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

/**
 * Daily fantasy: the weekly contest.
 *
 * One game a week, everybody in, no buy-in. Where you finish mints points that
 * spend in the same shop as trophies and the allowance.
 */
export default async function DailyPage({ searchParams }) {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to play.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  // An explicit ?week= wins, the way the board's switcher works. Without it
  // there was no way to look at another week at all.
  const params = await searchParams;
  const asked = Number(params?.week);
  const week = Number.isFinite(asked) && asked > 0 ? asked : await currentWeek(SEASON);
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
  const [entry, lobbies, points, field] = await Promise.all([
    guest ? null : lineupFor(slug, contest.id),
    openLobbies(SEASON, week),
    guest ? 0 : getPoints(slug, SEASON),
    // Names and salary spent only. Lineups stay withheld until the contest
    // locks -- contestField defaults to that, and asking for them here would
    // let the last person in copy the best team on the board.
    contestField(contest.id),
  ]);

  // Everyone who has NOT submitted. A list of who is in only answers half the
  // question -- the useful half on a Sunday morning is who still has to do it.
  const inIt = new Set(field.map((f) => f.bettor));
  const missing = (await listBettors()).filter((b) => !inIt.has(b.slug) && !isGuestSlug(b.slug));
  // Once the contest locks nobody CAN submit, so chasing them is wrong -- they
  // missed it. Same list, different sentence.
  const stillOpen = contest.status === 'open';

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

  // Whether this week has defence rankings at all. Without saying so, a missing
  // matchup line looks like a bug rather than data that is not published yet.
  const ranked = pool.some((p) => p.defRank != null);
  // If the rankings are carried over, say which week they are from rather than
  // implying they are this week's read on a defence.
  const staleFrom = pool.find((p) => p.defStale)?.defRankedWeek ?? null;

  return (
    <>
      <p className="page-sub">
        One game a week, everyone in. Build a lineup under the cap; where you finish pays
        points into the same bank the shop spends from.
      </p>

      <section className="section">
        <div className="section-head">
          <h2>Week {week}</h2>
          <a className="dim" href="/dfs/results">
            Results &rsaquo;
          </a>
        </div>
        <p className="note" style={{ padding: '0 2px 10px' }}>
          Salaries come from Sleeper&apos;s own projections, so a player they rate low is
          cheap whether or not he deserves to be — which is the whole game. First place
          pays <strong>{PLACE_POINTS[0]}</strong>, down to nothing for last.
        </p>
        {!ranked ? (
          <p className="note dim" style={{ padding: '0 2px 10px' }}>
            No defence rankings yet — the matchup line appears once FantasyPros publishes
            them.
          </p>
        ) : staleFrom ? (
          <p className="note dim" style={{ padding: '0 2px 10px' }}>
            Defence rankings are from <strong>week {staleFrom}</strong> — FantasyPros only
            publishes the current week. The opponent shown is this week&apos;s real
            fixture; only the ranking is carried over.
          </p>
        ) : null}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Who is in</h2>
          <span className="dim">
            {field.length} of {field.length + missing.length}
          </span>
        </div>
        {field.length === 0 ? (
          <div className="empty">Nobody has submitted a lineup yet.</div>
        ) : (
          <div className="rows">
            {field.map((f) => (
              <div key={f.bettor} className={`row ${f.bettor === slug ? 'row-me' : ''}`}>
                <span className="row-main">
                  <span className="row-name">{f.display_name}</span>
                  {/* Salary spent, never the players. The contest is still
                      open, so naming picks would turn it into a copying
                      exercise -- the same rule the lobby field follows. */}
                  <span className="dim">
                    ${f.salary_used.toLocaleString('en-US')} spent
                    {f.points != null && ` · ${f.points.toFixed(2)} pts`}
                  </span>
                </span>
                <span className="row-value pill teal">in</span>
              </div>
            ))}
          </div>
        )}
        {missing.length > 0 && (
          <p className="note dim" style={{ padding: '10px 2px 0' }}>
            {/* A half-built lineup is not an entry. Somebody who filled every
                slot and never pressed the button is still out, and this is the
                only place that says so. */}
            {stillOpen ? 'Still to submit: ' : 'Did not enter: '}
            {missing.map((b) => b.display_name).join(', ')}
          </p>
        )}
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
