import Link from 'next/link';
import { getLeague, getOwners } from '@/lib/data';

export const metadata = { title: 'Head to Head' };

export default function HeadToHeadPage() {
  const league = getLeague();
  // Only managers with real history — a single-season sub clutters the grid.
  const owners = getOwners()
    .filter((owner) => owner.games >= 20)
    .sort((a, b) => b.winPct - a.winPct);

  const lookup = new Map(
    league.headToHead.map((row) => [`${row.a}|${row.b}`, row])
  );

  // Shortest unambiguous label for the column headers.
  const shortName = (name) => {
    const [first, last] = name.split(' ');
    return last ? `${first[0]}. ${last}` : first;
  };

  const biggestRivalries = [...league.headToHead]
    .filter((row) => row.a < row.b && row.games >= 8)
    .sort((a, b) => b.games - a.games)
    .slice(0, 6);

  const byName = new Map(getOwners().map((owner) => [owner.slug, owner.name]));

  return (
    <>
      <header className="page-head">
        <h1>Head to Head</h1>
        <div className="sub">
          Regular-season record, row vs column · all{' '}
          {league.seasons.filter((s) => s.played).length} seasons
        </div>
      </header>

      <section className="section">
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th></th>
                {owners.map((owner) => (
                  <th key={owner.slug} title={owner.name}>
                    {shortName(owner.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {owners.map((rowOwner) => (
                <tr key={rowOwner.slug}>
                  <td>
                    <Link href={`/owner/${rowOwner.slug}`}>
                      {shortName(rowOwner.name)}
                    </Link>
                  </td>
                  {owners.map((colOwner) => {
                    if (rowOwner.slug === colOwner.slug) {
                      return (
                        <td key={colOwner.slug} className="dim">
                          —
                        </td>
                      );
                    }
                    const record = lookup.get(`${rowOwner.slug}|${colOwner.slug}`);
                    if (!record || record.games === 0) {
                      return (
                        <td key={colOwner.slug} className="dim">
                          ·
                        </td>
                      );
                    }
                    const cls =
                      record.wins > record.losses
                        ? 'pos'
                        : record.wins < record.losses
                          ? 'neg'
                          : 'dim';
                    return (
                      <td key={colOwner.slug} className={cls}>
                        {record.wins}-{record.losses}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">
          Scroll sideways to see every matchup. Green means the row manager leads
          the series. Managers with fewer than 20 games are omitted.
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Most-Played Rivalries</h2>
        </div>
        <div className="card rows">
          {biggestRivalries.map((row) => {
            // Always show the series from the leader's perspective, so the
            // record and the "X leads" label agree.
            const aLeads = row.wins >= row.losses;
            const leaderName = byName.get(aLeads ? row.a : row.b);
            const trailerName = byName.get(aLeads ? row.b : row.a);
            const leaderWins = aLeads ? row.wins : row.losses;
            const leaderLosses = aLeads ? row.losses : row.wins;
            const tied = row.wins === row.losses;

            return (
              <div className="row" key={`${row.a}-${row.b}`}>
                <span className="who">
                  <span className="name">
                    {leaderName} vs {trailerName}
                  </span>
                  <span className="detail">
                    {tied ? 'dead even' : `${leaderName} leads`} · {row.games} meetings ·{' '}
                    {Math.round(row.pointsFor + row.pointsAgainst).toLocaleString()} combined
                    points
                  </span>
                </span>
                <span className="stat">
                  {leaderWins}-{leaderLosses}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
