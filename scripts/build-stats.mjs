/**
 * Transforms raw ESPN season dumps into the stats the app renders.
 *
 *   node scripts/build-stats.mjs
 *
 * Writes data/league.json — a single file the Next.js app imports at build time.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOwnerIndex, resolveTeamOwner } from './owners.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, '..', 'data', 'raw');
const OUT_PATH = join(__dirname, '..', 'data', 'league.json');

/** A season counts toward records once at least one game has been played. */
const isPlayed = (game) =>
  (game.home?.totalPoints ?? 0) > 0 || (game.away?.totalPoints ?? 0) > 0;

const files = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.json')).sort();

const seasons = [];
for (const file of files) {
  const season = Number(file.replace('.json', ''));
  const data = JSON.parse(await readFile(join(RAW_DIR, file), 'utf8'));
  seasons.push({ season, data });
}

const { people, byGuid } = buildOwnerIndex(seasons);

// ---------- Per-person accumulators ----------

const stats = new Map();
function statsFor(slug) {
  if (!stats.has(slug)) {
    const person = people.get(slug);
    stats.set(slug, {
      slug,
      name: person?.name ?? slug,
      handles: [...(person?.handles ?? [])],
      accountCount: person?.guids.size ?? 1,
      seasons: [],
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      championships: 0,
      runnerUps: 0,
      thirdPlace: 0,
      lastPlace: 0,
      playoffAppearances: 0,
      playoffWins: 0,
      playoffLosses: 0,
      playoffGames: 0,
      regularSeasonTitles: 0,
      bestFinish: null,
      worstFinish: null,
      highestScore: null,
      lowestScore: null,
      weeklyScores: [],
    });
  }
  return stats.get(slug);
}

// Head-to-head: "a|b" -> { wins, losses, ties, pointsFor, pointsAgainst }
const h2h = new Map();
function h2hFor(a, b) {
  const key = `${a}|${b}`;
  if (!h2h.has(key)) {
    h2h.set(key, {
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      playoffWins: 0,
      playoffLosses: 0,
      playoffGames: 0,
    });
  }
  return h2h.get(key);
}

const seasonSummaries = [];
const allGames = [];

for (const { season, data } of seasons) {
  const teams = data.teams ?? [];
  const schedule = data.schedule ?? [];
  const playedGames = schedule.filter(isPlayed);

  // Map team id -> person slug for this season.
  const teamOwner = new Map();
  const teamName = new Map();
  for (const team of teams) {
    const slug = resolveTeamOwner(team, byGuid);
    if (slug) teamOwner.set(team.id, slug);
    teamName.set(
      team.id,
      team.name?.trim() || `${team.location ?? ''} ${team.nickname ?? ''}`.trim() || `Team ${team.id}`
    );
  }

  // Seasons 2008-2018 come from the kona_history_standings dump: they carry
  // team records and final ranks but no schedule. Those still count toward
  // wins/championships; they just cannot contribute head-to-head or per-game
  // records. Detect them by the presence of a record rather than a schedule.
  const standingsOnly = data.__source === 'kona_history_standings';
  const hasRecords = teams.some(
    (team) => (team.record?.overall?.wins ?? 0) + (team.record?.overall?.losses ?? 0) > 0
  );

  // A season with no completed games (e.g. the upcoming one) is recorded for
  // context but contributes nothing to records.
  const played = playedGames.length > 0 || (standingsOnly && hasRecords);

  // ESPN's regular season length; playoff games come after it.
  const regularSeasonWeeks =
    data.settings?.scheduleSettings?.matchupPeriodCount ?? 14;

  const finishes = [];

  if (played) {
    for (const team of teams) {
      const slug = teamOwner.get(team.id);
      if (!slug) continue;

      const record = team.record?.overall ?? {};
      const entry = statsFor(slug);

      entry.wins += record.wins ?? 0;
      entry.losses += record.losses ?? 0;
      entry.ties += record.ties ?? 0;
      entry.pointsFor += record.pointsFor ?? 0;
      entry.pointsAgainst += record.pointsAgainst ?? 0;

      const finish = team.rankCalculatedFinal || null;
      if (finish === 1) entry.championships++;
      if (finish === 2) entry.runnerUps++;
      if (finish === 3) entry.thirdPlace++;
      if (finish && finish === teams.length) entry.lastPlace++;

      // playoffSeed is set for teams that made the bracket.
      const madePlayoffs =
        team.playoffSeed > 0 &&
        team.playoffSeed <= (data.settings?.scheduleSettings?.playoffTeamCount ?? 6);
      if (madePlayoffs) entry.playoffAppearances++;

      if (finish != null) {
        if (entry.bestFinish == null || finish < entry.bestFinish) entry.bestFinish = finish;
        if (entry.worstFinish == null || finish > entry.worstFinish) entry.worstFinish = finish;
      }

      entry.seasons.push({
        season,
        teamName: teamName.get(team.id),
        wins: record.wins ?? 0,
        losses: record.losses ?? 0,
        ties: record.ties ?? 0,
        pointsFor: Math.round((record.pointsFor ?? 0) * 10) / 10,
        pointsAgainst: Math.round((record.pointsAgainst ?? 0) * 10) / 10,
        finish,
        playoffSeed: team.playoffSeed || null,
        madePlayoffs,
      });

      finishes.push({ slug, finish, wins: record.wins ?? 0, pointsFor: record.pointsFor ?? 0 });
    }

    // Regular-season title: best record among all teams (points break ties).
    const regularSeasonWinner = [...finishes].sort(
      (a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor
    )[0];
    if (regularSeasonWinner) statsFor(regularSeasonWinner.slug).regularSeasonTitles++;
  }

  // ---------- Per-game records and head-to-head ----------
  for (const game of playedGames) {
    const homeSlug = teamOwner.get(game.home?.teamId);
    const awaySlug = teamOwner.get(game.away?.teamId);
    const homePoints = game.home?.totalPoints ?? 0;
    const awayPoints = game.away?.totalPoints ?? 0;
    const isPlayoff = game.matchupPeriodId > regularSeasonWeeks;

    allGames.push({
      season,
      week: game.matchupPeriodId,
      isPlayoff,
      home: homeSlug,
      away: awaySlug,
      homePoints: Math.round(homePoints * 10) / 10,
      awayPoints: Math.round(awayPoints * 10) / 10,
      winner: game.winner,
    });

    for (const [slug, points, oppSlug, oppPoints] of [
      [homeSlug, homePoints, awaySlug, awayPoints],
      [awaySlug, awayPoints, homeSlug, homePoints],
    ]) {
      if (!slug) continue;
      const entry = statsFor(slug);
      entry.weeklyScores.push({ season, week: game.matchupPeriodId, points, opponent: oppSlug });

      if (isPlayoff) {
        entry.playoffGames++;
        if (points > oppPoints) entry.playoffWins++;
        else if (points < oppPoints) entry.playoffLosses++;
      }

      if (entry.highestScore == null || points > entry.highestScore.points) {
        entry.highestScore = { points: Math.round(points * 10) / 10, season, week: game.matchupPeriodId, opponent: oppSlug };
      }
      if (entry.lowestScore == null || points < entry.lowestScore.points) {
        entry.lowestScore = { points: Math.round(points * 10) / 10, season, week: game.matchupPeriodId, opponent: oppSlug };
      }
    }

    // Head-to-head, recorded from both sides. A person can never face
    // themselves, but guard anyway.
    //
    // Playoff meetings are tracked separately: ESPN's `record.overall` counts
    // only the regular season, so folding playoff games into the same totals
    // would make head-to-head disagree with the W-L shown everywhere else.
    if (homeSlug && awaySlug && homeSlug !== awaySlug) {
      const home = h2hFor(homeSlug, awaySlug);
      const away = h2hFor(awaySlug, homeSlug);
      home.pointsFor += homePoints;
      home.pointsAgainst += awayPoints;
      away.pointsFor += awayPoints;
      away.pointsAgainst += homePoints;

      const homeWon = homePoints > awayPoints;
      const awayWon = awayPoints > homePoints;

      if (isPlayoff) {
        home.playoffGames++;
        away.playoffGames++;
        if (homeWon) {
          home.playoffWins++;
          away.playoffLosses++;
        } else if (awayWon) {
          away.playoffWins++;
          home.playoffLosses++;
        }
      } else if (homeWon) {
        home.wins++;
        away.losses++;
      } else if (awayWon) {
        away.wins++;
        home.losses++;
      } else {
        home.ties++;
        away.ties++;
      }
    }
  }

  const champion = teams.find((t) => t.rankCalculatedFinal === 1);
  seasonSummaries.push({
    season,
    played,
    hasSchedule: playedGames.length > 0,
    teamCount: teams.length,
    champion: champion ? teamOwner.get(champion.id) ?? null : null,
    championTeamName: champion ? teamName.get(champion.id) : null,
    regularSeasonWeeks,
  });
}

// ---------- Derive final shapes ----------

const scheduledSeasonSet = new Set(allGames.map((game) => game.season));

const owners = [...stats.values()].map((entry) => {
  const games = entry.wins + entry.losses + entry.ties;

  // Points only exist for seasons with a schedule, so a per-game average has to
  // divide by those games alone — otherwise every long-tenured manager looks
  // like they scored nothing for a decade.
  const scheduledGames = entry.seasons
    .filter((season) => scheduledSeasonSet.has(season.season))
    .reduce((sum, season) => sum + season.wins + season.losses + season.ties, 0);
  const scores = entry.weeklyScores.map((s) => s.points);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const variance = scores.length
    ? scores.reduce((sum, s) => sum + (s - avg) ** 2, 0) / scores.length
    : 0;

  return {
    ...entry,
    // weeklyScores is only needed for the aggregates above; drop the bulk.
    weeklyScores: undefined,
    games,
    winPct: games ? Math.round((entry.wins / games) * 1000) / 10 : 0,
    pointsFor: Math.round(entry.pointsFor * 10) / 10,
    pointsAgainst: Math.round(entry.pointsAgainst * 10) / 10,
    pointsPerGame: games ? Math.round((entry.pointsFor / games) * 10) / 10 : 0,
    scheduledGames,
    pointsPerScheduledGame: scheduledGames
      ? Math.round((entry.pointsFor / scheduledGames) * 10) / 10
      : null,
    pointDifferential: Math.round((entry.pointsFor - entry.pointsAgainst) * 10) / 10,
    consistency: Math.round(Math.sqrt(variance) * 10) / 10,
    seasonsPlayed: entry.seasons.length,
  };
});

const headToHead = [...h2h.entries()].map(([key, value]) => {
  const [a, b] = key.split('|');
  const games = value.wins + value.losses + value.ties;
  return {
    a,
    b,
    ...value,
    games,
    winPct: games ? Math.round((value.wins / games) * 1000) / 10 : 0,
    pointsFor: Math.round(value.pointsFor * 10) / 10,
    pointsAgainst: Math.round(value.pointsAgainst * 10) / 10,
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  leagueName: seasons.at(-1)?.data.settings?.name ?? 'League',
  leagueId: seasons.at(-1)?.data.id ?? null,
  seasons: seasonSummaries,
  // Seasons with a full schedule — the only ones head-to-head and per-game
  // records can draw on. Earlier seasons are standings-only.
  scheduledSeasons: [...new Set(allGames.map((game) => game.season))].sort(),
  owners: owners.sort((a, b) => b.wins - a.wins),
  headToHead,
  games: allGames,
};

// ---------- Validation ----------
// These invariants catch the failure modes that would otherwise ship silently:
// double-counted owners, unresolved GUIDs, or head-to-head drifting out of sync
// with the season records.

const problems = [];

const totalWins = owners.reduce((sum, o) => sum + o.wins, 0);
const totalLosses = owners.reduce((sum, o) => sum + o.losses, 0);
if (totalWins !== totalLosses) {
  problems.push(`League wins (${totalWins}) != losses (${totalLosses})`);
}

// Every game must resolve to a person on both sides.
const orphanGames = allGames.filter((g) => !g.home || !g.away).length;
if (orphanGames > 0) {
  problems.push(`${orphanGames} games have an unresolved owner`);
}

// Head-to-head can only cover seasons where we have a schedule, so compare it
// against wins from those seasons alone — not the all-time total, which now
// includes standings-only seasons with no game-level data.
const h2hWins = headToHead.reduce((sum, r) => sum + r.wins, 0);
const scheduledSeasons = new Set(allGames.map((game) => game.season));
const scheduledWins = owners.reduce(
  (sum, owner) =>
    sum +
    owner.seasons
      .filter((season) => scheduledSeasons.has(season.season))
      .reduce((seasonSum, season) => seasonSum + season.wins, 0),
  0
);
if (h2hWins !== scheduledWins) {
  problems.push(
    `Head-to-head wins (${h2hWins}) != wins in scheduled seasons (${scheduledWins})`
  );
}

// One champion per completed season, no more.
for (const summary of seasonSummaries.filter((s) => s.played)) {
  if (!summary.champion) problems.push(`${summary.season} has no champion`);
}
const champTotal = owners.reduce((sum, o) => sum + o.championships, 0);
const playedSeasons = seasonSummaries.filter((s) => s.played).length;
if (champTotal !== playedSeasons) {
  problems.push(`${champTotal} championships across ${playedSeasons} played seasons`);
}

if (problems.length) {
  console.error('✗ Validation failed:');
  for (const problem of problems) console.error(`   - ${problem}`);
  process.exit(1);
}

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(OUT_PATH, JSON.stringify(output, null, 2), 'utf8');

console.log(`✓ data/league.json written`);
console.log(`  ${owners.length} owners, ${seasonSummaries.length} seasons, ${allGames.length} games`);
console.log(`  merged accounts: ${owners.filter((o) => o.accountCount > 1).map((o) => `${o.name} (${o.accountCount})`).join(', ') || 'none'}`);
