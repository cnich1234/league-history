import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOwners, getOwner, getHeadToHead, getLeague } from '@/lib/data';

/** Static export needs every owner page enumerated at build time. */
export function generateStaticParams() {
  return getOwners().map((owner) => ({ slug: owner.slug }));
}

export function generateMetadata({ params }) {
  const owner = getOwner(params.slug);
  return { title: owner?.name ?? 'Manager' };
}

export default function OwnerPage({ params }) {
  const owner = getOwner(params.slug);
  if (!owner) notFound();

  const league = getLeague();
  const h2h = getHeadToHead(owner.slug);
  const seasons = [...owner.seasons].sort((a, b) => b.season - a.season);

  const best = h2h.filter((row) => row.games >= 3).sort((a, b) => b.winPct - a.winPct)[0];
  const worst = h2h.filter((row) => row.games >= 3).sort((a, b) => a.winPct - b.winPct)[0];

  return (
    <>
      <Link href="/owners" className="back">
        ‹ Managers
      </Link>

      <header className="page-head">
        <h1>{owner.name}</h1>
        <div className="sub">
          {owner.wins}-{owner.losses}
          {owner.ties ? `-${owner.ties}` : ''} · {owner.winPct}% ·{' '}
          {owner.seasonsPlayed} seasons
          {owner.accountCount > 1 && (
            <>
              {' '}
              · <span className="pill">{owner.accountCount} accounts merged</span>
            </>
          )}
          {owner.nameUnknown && (
            <>
              {' '}
              · <span className="pill">franchise name</span>
            </>
          )}
        </div>
      </header>

      <section className="section">
        <div className="tiles">
          <div className="tile">
            <div className="label">Titles</div>
            <div className="value">{owner.championships}</div>
            <div className="meta">
              {owner.championships ? '🏆'.repeat(owner.championships) : 'still hunting'}
            </div>
          </div>
          <div className="tile">
            <div className="label">Playoffs</div>
            <div className="value">{owner.playoffAppearances}</div>
            <div className="meta">of {owner.seasonsPlayed} seasons</div>
          </div>
          <div className="tile">
            <div className="label">Points/game</div>
            <div className="value">{owner.pointsPerScheduledGame ?? '—'}</div>
            <div className="meta">
              {Math.round(owner.pointsFor).toLocaleString()} all-time
            </div>
          </div>
          <div className="tile">
            <div className="label">Best finish</div>
            <div className="value">{owner.bestFinish ?? '—'}</div>
            <div className="meta">worst {owner.worstFinish ?? '—'}</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Personal Records</h2>
        </div>
        <div className="tiles">
          {owner.highestScore && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Highest score</div>
              <div className="value">{owner.highestScore.points}</div>
              <div className="meta">
                {owner.highestScore.season} wk {owner.highestScore.week}
              </div>
            </div>
          )}
          {owner.lowestScore && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Lowest score</div>
              <div className="value">{owner.lowestScore.points}</div>
              <div className="meta">
                {owner.lowestScore.season} wk {owner.lowestScore.week}
              </div>
            </div>
          )}
          {best && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Favorite matchup</div>
              <div className="value">{best.wins}-{best.losses}</div>
              <div className="meta">vs {best.opponentName}</div>
            </div>
          )}
          {worst && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Toughest matchup</div>
              <div className="value">{worst.wins}-{worst.losses}</div>
              <div className="meta">vs {worst.opponentName}</div>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Season by Season</h2>
        </div>
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Season</th>
                <th>Record</th>
                <th>PF</th>
                <th>PA</th>
                <th>Finish</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((season) => (
                <tr key={season.season}>
                  <td>
                    {season.season}
                    <div className="dim" style={{ fontSize: 11 }}>
                      {season.teamName}
                    </div>
                  </td>
                  <td>
                    {season.wins}-{season.losses}
                    {season.ties ? `-${season.ties}` : ''}
                  </td>
                  <td>{season.pointsFor}</td>
                  <td>{season.pointsAgainst}</td>
                  <td>
                    {season.finish === 1 ? (
                      <span title="Champion">🏆</span>
                    ) : season.finish === 2 ? (
                      <span title="Runner-up">🥈</span>
                    ) : season.finish === 3 ? (
                      <span title="Third">🥉</span>
                    ) : (
                      <span className="dim">{season.finish ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Head to Head</h2>
        </div>
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Opponent</th>
                <th>Record</th>
                <th>Win%</th>
                <th>PF</th>
                <th>PA</th>
              </tr>
            </thead>
            <tbody>
              {h2h.map((row) => (
                <tr key={row.b}>
                  <td>
                    <Link href={`/owner/${row.b}`}>{row.opponentName}</Link>
                    {row.playoffGames > 0 && (
                      <div className="dim" style={{ fontSize: 11 }}>
                        {row.playoffWins}-{row.playoffLosses} in playoffs
                      </div>
                    )}
                  </td>
                  <td>
                    {row.wins}-{row.losses}
                    {row.ties ? `-${row.ties}` : ''}
                  </td>
                  <td className={row.winPct > 50 ? 'pos' : row.winPct < 50 ? 'neg' : 'dim'}>
                    {row.winPct}%
                  </td>
                  <td>{row.pointsFor}</td>
                  <td>{row.pointsAgainst}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">
          Regular-season meetings across all {league.seasons.filter((s) => s.played).length}{' '}
          seasons. Playoff meetings are noted separately under each opponent.
        </div>
      </section>
    </>
  );
}
