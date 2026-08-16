import {
  leaderboard,
  getScoringExtremes,
  getMarginExtremes,
  getOwners,
  getLeague,
  getPlayedSeasons,
} from '@/lib/data';
import RankRow from '@/components/RankRow';

export const metadata = { title: 'Records' };

/** Leaderboards rendered on this page, in order. */
const BOARDS = [
  { title: 'Most Wins', field: 'wins', detail: (o) => `${o.wins}-${o.losses} · ${o.winPct}%` },
  { title: 'Most Losses', field: 'losses', detail: (o) => `${o.wins}-${o.losses} · ${o.winPct}%` },
  {
    title: 'Most Championships',
    field: 'championships',
    detail: (o) => '🏆'.repeat(o.championships) || '—',
    filter: (o) => o.championships > 0,
    // 10 of 15 managers have won at least once — worth showing them all.
    limit: 12,
  },
  {
    title: 'Most Playoff Appearances',
    field: 'playoffAppearances',
    detail: (o) => `${o.playoffAppearances} of ${o.seasonsPlayed} seasons`,
  },
  {
    title: 'Most Points Scored',
    field: 'pointsFor',
    format: (v) => Math.round(v).toLocaleString(),
    detail: (o) => `${o.pointsPerScheduledGame ?? '—'} per game`,
    filter: (o) => o.pointsFor > 0,
    scoped: true,
  },
  {
    title: 'Highest Scoring Average',
    field: 'pointsPerScheduledGame',
    detail: (o) => `${Math.round(o.pointsFor).toLocaleString()} total`,
    filter: (o) => o.scheduledGames >= 40,
    scoped: true,
  },
  {
    title: 'Best Point Differential',
    field: 'pointDifferential',
    format: (v) => (v > 0 ? `+${Math.round(v)}` : Math.round(v).toString()),
    detail: (o) =>
      `${Math.round(o.pointsFor).toLocaleString()} for / ${Math.round(o.pointsAgainst).toLocaleString()} against`,
    filter: (o) => o.pointsFor > 0,
    scoped: true,
  },
  {
    title: 'Most Consistent',
    field: 'consistency',
    ascending: true,
    format: (v) => `±${v}`,
    detail: (o) => `${o.pointsPerScheduledGame} per game`,
    filter: (o) => o.scheduledGames >= 40,
    scoped: true,
  },
  {
    title: 'Runner-Up Finishes',
    field: 'runnerUps',
    detail: (o) => `${o.runnerUps} second-place`,
    filter: (o) => o.runnerUps > 0,
  },
  {
    title: 'Last Place Finishes',
    field: 'lastPlace',
    detail: (o) => `${o.lastPlace} time${o.lastPlace === 1 ? '' : 's'}`,
    filter: (o) => o.lastPlace > 0,
  },
];

export default function RecordsPage() {
  const { highest, lowest } = getScoringExtremes();
  const { blowout, nailbiter } = getMarginExtremes();
  const owners = getOwners();
  const league = getLeague();
  const scheduledFrom = league.scheduledSeasons[0];
  const scheduledTo = league.scheduledSeasons.at(-1);
  const playedSeasons = getPlayedSeasons();

  // Championship rate: titles per season played, for managers with 3+ seasons.
  const titleRate = [...owners]
    .filter((owner) => owner.seasonsPlayed >= 3)
    .map((owner) => ({
      ...owner,
      rate: Math.round((owner.championships / owner.seasonsPlayed) * 1000) / 10,
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);

  return (
    <>
      <header className="page-head">
        <h1>Records</h1>
        <div className="sub">
          {playedSeasons[0]?.season}–{playedSeasons.at(-1)?.season} ·{' '}
          {playedSeasons.length} seasons
        </div>
      </header>

      <section className="section">
        <div className="section-head">
          <h2>Single Game</h2>
        </div>
        <div className="tiles">
          <div className="tile" style={{ gridColumn: 'span 2' }}>
            <div className="label">Highest score</div>
            <div className="value">{highest?.points}</div>
            <div className="meta">
              {highest?.name} vs {highest?.opponentName} · {highest?.season} wk {highest?.week}
            </div>
          </div>
          <div className="tile" style={{ gridColumn: 'span 2' }}>
            <div className="label">Lowest score</div>
            <div className="value">{lowest?.points}</div>
            <div className="meta">
              {lowest?.name} vs {lowest?.opponentName} · {lowest?.season} wk {lowest?.week}
            </div>
          </div>
          <div className="tile" style={{ gridColumn: 'span 2' }}>
            <div className="label">Biggest blowout</div>
            <div className="value">+{blowout?.margin}</div>
            <div className="meta">
              {blowout?.winnerName} {blowout?.winnerPoints} – {blowout?.loserPoints}{' '}
              {blowout?.loserName}
            </div>
          </div>
          <div className="tile" style={{ gridColumn: 'span 2' }}>
            <div className="label">Closest finish</div>
            <div className="value">{nailbiter?.margin}</div>
            <div className="meta">
              {nailbiter?.winnerName} {nailbiter?.winnerPoints} – {nailbiter?.loserPoints}{' '}
              {nailbiter?.loserName}
            </div>
          </div>
        </div>
        <div className="note">
          Single-game records cover {scheduledFrom}–{scheduledTo}. ESPN returns
          final standings for earlier seasons but no individual scores.
        </div>
      </section>

      {BOARDS.map((board) => {
        let rows = leaderboard(board.field, {
          ascending: board.ascending,
          minGames: board.minGames ?? 0,
        });
        if (board.filter) rows = rows.filter(board.filter);
        rows = rows.slice(0, board.limit ?? 5);
        if (rows.length === 0) return null;

        return (
          <section className="section" key={board.title}>
            <div className="section-head">
              <h2>{board.title}</h2>
            </div>
            <div className="card rows">
              {rows.map((owner, index) => (
                <RankRow
                  key={owner.slug}
                  rank={index + 1}
                  owner={owner}
                  stat={
                    board.format
                      ? board.format(owner[board.field])
                      : owner[board.field]
                  }
                  detail={board.detail?.(owner)}
                />
              ))}
            </div>
            {board.minGames ? (
              <div className="note">Minimum {board.minGames} games played.</div>
            ) : null}
            {board.scoped ? (
              <div className="note">
                {scheduledFrom}–{scheduledTo} only — ESPN does not serve
                game-level scoring for earlier seasons.
              </div>
            ) : null}
            {board.field === 'consistency' ? (
              <div className="note">
                Lower is steadier — this is the standard deviation of weekly scores.
              </div>
            ) : null}
          </section>
        );
      })}

      <section className="section">
        <div className="section-head">
          <h2>Championship Rate</h2>
        </div>
        <div className="card rows">
          {titleRate.map((owner, index) => (
            <RankRow
              key={owner.slug}
              rank={index + 1}
              owner={owner}
              stat={`${owner.rate}%`}
              detail={`${owner.championships} in ${owner.seasonsPlayed} seasons`}
            />
          ))}
        </div>
        <div className="note">Minimum 3 seasons played.</div>
      </section>
    </>
  );
}
