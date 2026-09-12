import { neon } from '@neondatabase/serverless';
import { currentBettor, isGuestSlug } from '@/lib/auth';
import {
  salaryPool,
  myEntry,
  contestField,
  LINEUP,
  FLEX_POSITIONS,
  SALARY_CAP,
} from '@/lib/dfs';
import LineupBuilder from '@/components/LineupBuilder';

export const metadata = { title: 'Lobby' };
export const dynamic = 'force-dynamic';

const sql = neon(process.env.DATABASE_URL);

/**
 * One lobby: who is in it, and your lineup for it.
 *
 * The field is shown by NAME and salary spent, never by players -- everyone
 * drafts from the same pool, and seeing somebody else's lineup before lock
 * would make a lobby a copying exercise.
 */
export default async function LobbyPage({ params }) {
  const { id } = await params;
  const slug = await currentBettor();
  if (!slug) {
    return (
      <section className="section">
        <div className="empty">Sign in on the board to play.</div>
      </section>
    );
  }

  const [lobby] = await sql`
    select c.*, h.display_name as host_name
    from dfs_contests c
    join bettors h on h.slug = c.host
    where c.id = ${Number(id)} and c.kind = 'lobby'`;

  if (!lobby) {
    return (
      <section className="section">
        <div className="empty">No such lobby.</div>
      </section>
    );
  }

  const guest = isGuestSlug(slug);
  const [pool, field, entry] = await Promise.all([
    salaryPool(lobby.season, lobby.week),
    contestField(lobby.id),
    guest ? null : myEntry(slug, lobby.id),
  ]);

  const taken = field.length;
  const settled = lobby.status === 'settled' || lobby.status === 'void';
  const full = taken >= Number(lobby.seats);
  // A lineup can still be edited when the lobby is open, even once full.
  const canEnter = !guest && !settled && lobby.status === 'open' && (entry || !full);

  return (
    <>
      <p className="page-sub">
        {lobby.name || `${lobby.host_name}'s lobby`} · week {lobby.week}
      </p>

      <section className="section">
        <div className="dfs-cap">
          <div>
            <div className="dim">Pot</div>
            <div className="dfs-left">{Number(lobby.buyin_points) * taken}</div>
          </div>
          <div className="dfs-cap-side">
            <div className="dim">
              {taken}/{lobby.seats} seats · {lobby.buyin_points} to enter
            </div>
            <div className="dim">winner takes it all</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>The field</h2>
          <span className="dim">{taken} in</span>
        </div>
        {taken === 0 ? (
          <div className="empty">Nobody has entered yet.</div>
        ) : (
          <div className="rows">
            {field.map((f) => (
              <div key={f.bettor} className={`row ${f.bettor === slug ? 'row-me' : ''}`}>
                <span className="row-main">
                  <span className="row-name">
                    {f.display_name}
                    {f.place === 1 && settled && <span className="pill teal"> won</span>}
                  </span>
                  {/* Salary spent, never the players: before lock that would
                      turn a lobby into a copying exercise. */}
                  <span className="dim">
                    ${f.salary_used.toLocaleString('en-US')} spent
                    {f.points != null && ` · ${f.points.toFixed(2)} pts`}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {canEnter ? (
        <LineupBuilder
          contestId={String(lobby.id)}
          week={lobby.week}
          lineup={LINEUP}
          flexPositions={FLEX_POSITIONS}
          cap={SALARY_CAP}
          pool={pool}
          initialSlots={entry?.slots ?? null}
        />
      ) : (
        <section className="section">
          <div className="empty">
            {guest
              ? 'Guests can look, but not enter.'
              : settled
                ? 'This one is done.'
                : full
                  ? 'This lobby is full.'
                  : 'Entries have closed.'}
          </div>
        </section>
      )}
    </>
  );
}
