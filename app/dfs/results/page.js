import { currentBettor } from '@/lib/auth';
import { currentWeek } from '@/lib/book';
import { weekResults, photoFor } from '@/lib/dfs';
import PlayerPhoto from '@/components/PlayerPhoto';

export const metadata = { title: 'Daily results' };
export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Watch the scores and everybody's lineups.
 *
 * A lineup appears once it is locked -- once one of its players has kicked
 * off. Before that it is still being edited, and publishing it would let the
 * last person in copy the best lineup on the board, which is the same reason
 * the lobby page shows salary spent rather than players. Somebody rostering
 * only the late game is listed by name and nothing else until then.
 *
 * A locked lineup is scored live off the same endpoint the board polls, so
 * this moves while the games run. A settled contest keeps the number it
 * settled at.
 */
export default async function DailyResultsPage({ searchParams }) {
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to watch.</div>
      </section>
    );
  }

  const params = await searchParams;
  const asked = Number(params?.week);
  const week = Number.isFinite(asked) && asked > 0 ? asked : await currentWeek(SEASON);
  const { contests } = await weekResults(SEASON, week);

  return (
    <>
      <p className="page-sub">
        Every lineup, scored live. A lineup appears once one of its players has kicked
        off — before that, publishing it would just be handing out the answer.
      </p>

      {contests.length === 0 ? (
        <section className="section">
          <div className="empty">No contests for week {week} yet.</div>
        </section>
      ) : (
        contests.map((c) => (
          <section className="section" key={c.id}>
            <div className="section-head">
              <h2>
                {c.kind === 'weekly' ? `Week ${week}` : c.name || `${c.host_name}'s lobby`}
              </h2>
              <span className="dim">
                {c.status === 'settled' ? 'final' : 'live'}
                {c.kind === 'lobby' && ` · ${c.pot} pot`}
              </span>
            </div>

            <div className="dfs-results">
              {c.field.map((f, i) => (
                <details
                  key={f.bettor}
                  className="dfs-result"
                  open={f.bettor === slug && !f.hidden}
                >
                  <summary>
                    <span className="dfs-result-place">{f.hidden ? '·' : i + 1}</span>
                    <span className="dfs-result-who">
                      {f.display_name}
                      {f.bettor === slug && <span className="dim"> · you</span>}
                      {f.hidden && <span className="dim"> · not locked yet</span>}
                    </span>
                    <span className="dfs-result-pts">{f.hidden ? '—' : f.live.toFixed(2)}</span>
                  </summary>

                  {!f.hidden && (
                  <div className="dfs-result-lineup">
                    {f.players.map((p) => (
                      <div key={`${f.bettor}-${p.slot}-${p.id}`} className="dfs-result-row">
                        <span className="dfs-slot-pos">{p.slot}</span>
                        <PlayerPhoto
                          src={photoFor(p.id, p.position, p.nflTeam)}
                          name={p.name}
                          position={p.position}
                          size={28}
                        />
                        <span className="dfs-slot-main">
                          <span className="dfs-slot-name">{p.name}</span>
                          <span className="dim">
                            {p.position} · {p.nflTeam ?? '—'} · $
                            {p.salary.toLocaleString('en-US')}
                          </span>
                        </span>
                        <span
                          className={`dfs-result-row-pts ${p.points > 0 ? 'pos' : 'dim'}`}
                        >
                          {p.points.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                  )}
                </details>
              ))}
            </div>
          </section>
        ))
      )}
    </>
  );
}
