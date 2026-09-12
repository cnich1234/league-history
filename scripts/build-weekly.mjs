/**
 * Pulls Sleeper matchup data and scores every achievement for a week.
 * Writes data/weekly.json, which the site reads at build time.
 *
 * Reruns are idempotent: a week already present is recomputed and replaced, so
 * fixing a scoring correction is just running this again.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SLEEPER_OWNERS } from './sleeper-owners.mjs';
import { ACHIEVEMENTS } from './achievements.mjs';

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
const SEASON = Number(process.env.BOOK_SEASON ?? 2026);
const OUT = 'data/weekly.json';
/**
 * There is no player file. Name and position come from the projections payload
 * fetched below, which carries both for every player who is projected -- and
 * every player who can score is projected.
 *
 * A 15MB local file used to be read here, by a hard-coded path on one laptop.
 * On Vercel `readFileSync` threw ENOENT, the cron's scoring try caught it, and
 * the deployed cron never scored a week. Scoring with and without that file
 * produced identical awards, so it is gone rather than made optional.
 */

const api = async (p) => {
  const r = await fetch(`https://api.sleeper.app/v1${p}`);
  if (!r.ok) throw new Error(`Sleeper ${p} -> ${r.status}`);
  return r.json();
};

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Prior W-L for every roster, so "upset" means better record BEFORE this week. */
async function recordsBefore(week) {
  const rec = {};
  for (let w = 1; w < week; w++) {
    let ms;
    try {
      ms = await api(`/league/${LEAGUE_ID}/matchups/${w}`);
    } catch {
      continue;
    }
    const byMatch = {};
    for (const m of ms) (byMatch[m.matchup_id] ??= []).push(m);
    for (const pair of Object.values(byMatch)) {
      if (pair.length !== 2 || pair.every((p) => !p.points)) continue;
      const [a, b] = pair;
      const aw = (rec[a.roster_id] ??= { w: 0, l: 0, streak: 0 });
      const bw = (rec[b.roster_id] ??= { w: 0, l: 0, streak: 0 });
      if (a.points === b.points) continue;
      const [win, lose] = a.points > b.points ? [aw, bw] : [bw, aw];
      win.w++;
      win.streak = win.streak >= 0 ? win.streak + 1 : 1;
      lose.l++;
      lose.streak = lose.streak <= 0 ? lose.streak - 1 : -1;
    }
  }
  return rec;
}

/**
 * Per-player projections and raw stats for a week.
 *
 * Needed by three awards that cannot be computed from matchup points alone:
 * the two projection awards compare a score to what was expected, and the
 * yardage awards need rushing and receiving yards rather than fantasy points.
 *
 * Both endpoints are undocumented but stable, and both are already used
 * elsewhere in the app. A failure here degrades those awards to "nobody won
 * it" rather than failing the whole week.
 */
async function loadWeekExtras(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const statsUrl =
    `https://api.sleeper.com/stats/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&order_by=pts_ppr`;

  const projections = {};
  const stats = {};
  // Name and position, from the `player` block each projection row carries.
  // This is what the 15MB player file used to be read for.
  const players = {};
  try {
    const [pRes, sRes] = await Promise.all([fetch(url), fetch(statsUrl)]);
    if (pRes.ok) {
      for (const r of await pRes.json()) {
        if (!r.player_id) continue;
        if (typeof r?.stats?.pts_ppr === 'number') {
          projections[r.player_id] = r.stats.pts_ppr;
        }
        if (r.player) {
          players[r.player_id] = {
            first_name: r.player.first_name,
            last_name: r.player.last_name,
            position: r.player.position,
          };
        }
      }
    }
    if (sRes.ok) {
      for (const r of await sRes.json()) {
        if (!r.player_id) continue;
        stats[r.player_id] = {
          recYards: r.stats?.rec_yd ?? 0,
          rushYards: r.stats?.rush_yd ?? 0,
        };
      }
    }
  } catch {
    // Leave them empty; the awards that need them simply find no winner.
  }
  return { projections, stats, players };
}

export async function buildWeek(week) {
  const [users, rosters, matchups, transactions] = await Promise.all([
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
    // Trades and waiver pickups. A failure here costs two awards rather than
    // the whole week, so it degrades to an empty list.
    api(`/league/${LEAGUE_ID}/transactions/${week}`).catch(() => []),
  ]);
  if (!matchups.some((m) => m.points > 0)) {
    throw new Error(`Week ${week} has no scores yet.`);
  }

  const prior = await recordsBefore(week);
  const { projections, stats, players: projected } = await loadWeekExtras(SEASON, week);
  const players = projected;
  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

  const teams = [];
  const allStarters = [];

  for (const m of matchups) {
    const r = rosterById[m.roster_id];
    const owner = SLEEPER_OWNERS[r.owner_id];
    if (!owner) continue;
    const u = userById[r.owner_id];
    const pts = m.players_points ?? {};
    const starterIds = (m.starters ?? []).filter((id) => id && id !== '0');
    const benchIds = (m.players ?? []).filter((id) => !starterIds.includes(id));

    const named = (id) => {
      const p = players[id] ?? {};
      const st = stats[id] ?? {};
      return {
        id,
        name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || id,
        position: p.position ?? '?',
        points: +(pts[id] ?? 0).toFixed(2),
        projected: projections[id] ?? null,
        recYards: st.recYards ?? 0,
        rushYards: st.rushYards ?? 0,
        // A player with no game that week -- bye or inactive -- could not have
        // been started, which is what the lineup award has to know.
        played: (pts[id] ?? 0) !== 0 || (st.recYards ?? 0) > 0 || (st.rushYards ?? 0) > 0,
      };
    };
    const starters = starterIds.map(named);
    const bench = benchIds.map(named);
    for (const s of starters) allStarters.push({ ...s, slug: owner.slug });

    // Same-position comparison only: a benched QB is not evidence you should
    // have started him over an RB.
    let worst = null;
    for (const b of bench) {
      const swappable = starters.filter((s) => s.position === b.position);
      const weakest = [...swappable].sort((x, y) => x.points - y.points)[0];
      if (weakest && b.points > weakest.points) {
        const swing = +(b.points - weakest.points).toFixed(2);
        if (!worst || swing > worst.swing) {
          worst = {
            benched: b.name,
            benchedPoints: b.points,
            started: weakest.name,
            startedPoints: weakest.points,
            swing,
          };
        }
      }
    }

    const pr = prior[m.roster_id] ?? { w: 0, l: 0, streak: 0 };
    teams.push({
      slug: owner.slug,
      name: owner.name,
      team: u?.metadata?.team_name || owner.name,
      rosterId: m.roster_id,
      matchupId: m.matchup_id,
      points: +(m.points ?? 0).toFixed(2),
      benchPoints: +bench.reduce((a, b) => a + b.points, 0).toFixed(2),
      worstBenchMistake: worst,
      // What Sleeper expected this lineup to score. Null when projections
      // could not be loaded, which the awards check for rather than treating
      // a missing projection as zero.
      projected: starters.every((x) => x.projected == null)
        ? null
        : +starters.reduce((a, x) => a + (x.projected ?? 0), 0).toFixed(2),
      // Points left on the bench by players who ACTUALLY PLAYED and could have
      // started in place of someone weaker at the same position. The old
      // benchPoints figure counted injured and bye-week players, so a manager
      // with a thin bench won the lineup award by having nothing to leave.
      missedPoints: +bench
        .filter((b) => b.played)
        .reduce((total, b) => {
          const swappable = starters.filter((x) => x.position === b.position);
          const weakest = [...swappable].sort((x, y) => x.points - y.points)[0];
          return weakest && b.points > weakest.points
            ? total + (b.points - weakest.points)
            : total;
        }, 0)
        .toFixed(2),
      recordBefore: `${pr.w}-${pr.l}`,
      winPctBefore: pr.w + pr.l ? pr.w / (pr.w + pr.l) : 0,
      winStreak: Math.max(0, pr.streak),
    });
  }

  const byMatch = {};
  for (const t of teams) (byMatch[t.matchupId] ??= []).push(t);
  const games = Object.values(byMatch)
    .filter((p) => p.length === 2)
    .map((pair) => {
      const [win, lose] = [...pair].sort((a, b) => b.points - a.points);
      return {
        winnerSlug: win.slug,
        winnerName: win.team,
        winnerPoints: win.points,
        loserSlug: lose.slug,
        loserName: lose.team,
        loserPoints: lose.points,
        loserRecordBefore: lose.recordBefore,
        margin: +(win.points - lose.points).toFixed(2),
        upset: lose.winPctBefore > win.winPctBefore,
        // Both sides, so "did you beat the spread" can be asked of the loser
        // as well as the winner -- which is the entire point of that award.
        sides: pair.map((t) => ({
          slug: t.slug,
          points: t.points,
          projected: t.projected,
          // What the model expected this side to win or lose by. A team
          // projected to lose by 20 that loses by 5 beat the spread.
          expectedMargin:
            t.projected == null || pair.some((x) => x.projected == null)
              ? null
              : +(t.projected - pair.find((x) => x.slug !== t.slug).projected).toFixed(2),
          actualMargin: +(t.points - pair.find((x) => x.slug !== t.slug).points).toFixed(2),
        })),
      };
    });

  // Who traded, and who picked someone up. Keyed by roster so the awards can
  // map them to a manager the same way everything else does.
  const tradedRosters = new Set();
  const pickups = [];
  for (const t of Array.isArray(transactions) ? transactions : []) {
    if (t.status !== 'complete') continue;
    if (t.type === 'trade') {
      for (const r of t.roster_ids ?? []) tradedRosters.add(r);
      continue;
    }
    // A waiver claim or free-agent add. `adds` maps playerId -> rosterId.
    if (t.type === 'waiver' || t.type === 'free_agent') {
      for (const [playerId, rosterId] of Object.entries(t.adds ?? {})) {
        pickups.push({ playerId, rosterId });
      }
    }
  }

  const slugOfRoster = (rosterId) => {
    const r = rosterById[rosterId];
    return SLEEPER_OWNERS[r?.owner_id]?.slug ?? null;
  };

  const ctx = {
    teams,
    games,
    allStarters,
    median: median(teams.map((t) => t.points)),
    // Managers who completed a trade this week.
    traded: [...tradedRosters].map(slugOfRoster).filter(Boolean),
    // Players picked up this week, with whoever claimed them. The award only
    // counts the ones who were actually STARTED -- a pickup left on the bench
    // was not a decision that paid off.
    pickups: pickups
      .map((p) => ({ ...p, slug: slugOfRoster(p.rosterId) }))
      .filter((p) => p.slug),
  };

  // A team's win streak counts THIS week's result too.
  for (const t of teams) {
    const won = games.some((g) => g.winnerSlug === t.slug);
    t.winStreak = won ? t.winStreak + 1 : 0;
  }

  const awards = [];
  for (const a of ACHIEVEMENTS) {
    for (const win of a.compute(ctx)) {
      awards.push({ achievement: a.id, slug: win.slug, detail: win.detail, points: a.points });
    }
  }

  const totals = {};
  for (const a of awards) totals[a.slug] = (totals[a.slug] ?? 0) + a.points;
  const weekWinnerPoints = Math.max(...Object.values(totals));
  const weekWinners = Object.keys(totals).filter((s) => totals[s] === weekWinnerPoints);

  return {
    week,
    generatedAt: new Date().toISOString(),
    median: +ctx.median.toFixed(2),
    teams: teams.map(({ winPctBefore, matchupId, rosterId, ...keep }) => keep),
    games,
    awards,
    totals,
    weekWinners,
    weekWinnerPoints,
  };
}

async function main() {
  const week = Number(process.argv[2]);
  if (!week) {
    console.error('Usage: node scripts/build-weekly.mjs <week>');
    process.exit(1);
  }

  const store = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { weeks: [] };
  const built = await buildWeek(week);
  store.weeks = [...store.weeks.filter((w) => w.week !== week), built].sort((a, b) => a.week - b.week);

  // Season standings are derived, never stored incrementally -- recomputing
  // from scratch means a corrected week cannot leave a stale total behind.
  const season = {};
  for (const w of store.weeks) {
    for (const [slug, pts] of Object.entries(w.totals)) {
      const s = (season[slug] ??= { slug, points: 0, weeksWon: 0, badges: {} });
      s.points += pts;
      if (w.weekWinners.includes(slug)) s.weeksWon++;
    }
    for (const a of w.awards) {
      const s = season[a.slug];
      if (s) s.badges[a.achievement] = (s.badges[a.achievement] ?? 0) + 1;
    }
  }
  store.season = Object.values(season).sort((a, b) => b.points - a.points);
  store.generatedAt = new Date().toISOString();

  writeFileSync(OUT, JSON.stringify(store, null, 2));

  // Also to the database, which is what the site actually reads now. The file
  // is kept as a local artefact for inspecting a week by hand.
  try {
    const { saveWeek } = await import('../lib/trophies.js');
    await saveWeek(SEASON, built);
    console.log('saved to the database');
  } catch (e) {
    console.warn('database save failed:', e.message);
  }
  console.log(`Week ${week}: ${built.awards.length} awards`);
  console.log(`Week winner(s): ${built.weekWinners.join(', ')} (${built.weekWinnerPoints} pts)`);
  console.log('\nSeason standings:');
  for (const [i, s] of store.season.entries()) {
    console.log(`  ${i + 1}. ${s.slug.padEnd(20)} ${s.points} pts`);
  }
}

// pathToFileURL handles Windows drive letters and separators; hand-rolling the
// comparison silently skipped main() and exited 0 with no output.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
