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
const OUT = 'data/weekly.json';
const PLAYERS = 'C:/Users/chris/fantasy/draft-tool/data/sleeper-players.json';

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

export async function buildWeek(week) {
  const [users, rosters, matchups] = await Promise.all([
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
  ]);
  if (!matchups.some((m) => m.points > 0)) {
    throw new Error(`Week ${week} has no scores yet.`);
  }

  const players = JSON.parse(readFileSync(PLAYERS, 'utf8'));
  const prior = await recordsBefore(week);
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
      return {
        name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || id,
        position: p.position ?? '?',
        points: +(pts[id] ?? 0).toFixed(2),
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
      };
    });

  const ctx = { teams, games, allStarters, median: median(teams.map((t) => t.points)) };

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
