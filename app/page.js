import Link from 'next/link';
import {
  getLeague,
  getPlayedSeasons,
  leaderboard,
  getScoringExtremes,
  getMarginExtremes,
} from '@/lib/data';
import RankRow from '@/components/RankRow';

export default function HomePage() {
  const league = getLeague();
  const seasons = getPlayedSeasons();
  const owners = league.owners;

  const mostWins = leaderboard('wins', { limit: 5 });
  // Everyone with a title, for the count; the list below shows the top few.
  const allChampions = leaderboard('championships').filter(
    (owner) => owner.championships > 0
  );
  const mostChampionships = allChampions.slice(0, 5);
  const bestWinPct = leaderboard('winPct', { minGames: 40, limit: 5 });

  const { highest } = getScoringExtremes();
  const { blowout } = getMarginExtremes();

  const totalGames = league.games.length;
  const totalPoints = owners.reduce((sum, owner) => sum + owner.pointsFor, 0);

  const firstSeason = seasons[0]?.season;
  const lastSeason = seasons.at(-1)?.season;

  return (
    <>
      <header className="page-head">
        <h1>{league.leagueName}</h1>
        <div className="sub">
          {firstSeason}–{lastSeason} · {seasons.length} seasons · {owners.length} managers
        </div>
      </header>

      <section className="section">
        <div className="tiles">
          <div className="tile">
            <div className="label">Seasons</div>
            <div className="value">{seasons.length}</div>
            <div className="meta">
              since {firstSeason}
            </div>
          </div>
          <div className="tile">
            <div className="label">Managers</div>
            <div className="value">{owners.length}</div>
            <div className="meta">all-time</div>
          </div>
          <div className="tile">
            <div className="label">Games</div>
            <div className="value">
              {owners.reduce((sum, owner) => sum + owner.games, 0) / 2}
            </div>
            <div className="meta">regular season</div>
          </div>
          <div className="tile">
            <div className="label">Champions</div>
            <div className="value">{allChampions.length}</div>
            <div className="meta">different winners</div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Most Championships</h2>
          <Link href="/records">All records →</Link>
        </div>
        <div className="card rows">
          {mostChampionships.map((owner, index) => (
            <RankRow
              key={owner.slug}
              rank={index + 1}
              owner={owner}
              stat={owner.championships}
              detail={'🏆'.repeat(Math.min(owner.championships, 5))}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Most Wins</h2>
          <Link href="/owners">All managers →</Link>
        </div>
        <div className="card rows">
          {mostWins.map((owner, index) => (
            <RankRow
              key={owner.slug}
              rank={index + 1}
              owner={owner}
              stat={owner.wins}
              detail={`${owner.wins}-${owner.losses} · ${owner.winPct}%`}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Best Win Percentage</h2>
        </div>
        <div className="card rows">
          {bestWinPct.map((owner, index) => (
            <RankRow
              key={owner.slug}
              rank={index + 1}
              owner={owner}
              stat={`${owner.winPct}%`}
              detail={`${owner.wins}-${owner.losses} in ${owner.seasonsPlayed} seasons`}
            />
          ))}
        </div>
        <div className="note">Minimum 40 games played.</div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>League Records</h2>
        </div>
        <div className="tiles">
          {highest && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Highest score</div>
              <div className="value">{highest.points}</div>
              <div className="meta">
                {highest.name} · {highest.season} wk {highest.week}
              </div>
            </div>
          )}
          {blowout && (
            <div className="tile" style={{ gridColumn: 'span 2' }}>
              <div className="label">Biggest blowout</div>
              <div className="value">+{blowout.margin}</div>
              <div className="meta">
                {blowout.winnerName} over {blowout.loserName} · {blowout.season}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Champions by Season</h2>
        </div>
        <div className="card rows">
          {[...seasons].reverse().map((season) => {
            const champion = owners.find((owner) => owner.slug === season.champion);
            return (
              <Link
                key={season.season}
                href={champion ? `/owner/${champion.slug}` : '#'}
                className="row"
              >
                <span className="rank gold">{season.season}</span>
                <span className="who">
                  <span className="name">{champion?.name ?? 'Unknown'}</span>
                  <span className="detail">{season.championTeamName}</span>
                </span>
                <span className="chev">›</span>
              </Link>
            );
          })}
        </div>
      </section>
    </>
  );
}
