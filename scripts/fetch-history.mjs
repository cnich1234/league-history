/**
 * Pulls every season of ESPN league history and writes raw JSON to data/raw/.
 *
 * ESPN's public endpoints need no auth for this league, so this is safe to
 * re-run. Past seasons never change, so in practice you run it once and again
 * after each new season ends.
 *
 *   node scripts/fetch-history.mjs
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSeason } from './espn.mjs';

/**
 * Load .env.local without a dotenv dependency.
 *
 * Seasons 2019+ are public, but 2008-2018 return 401
 * ("You are not authorized to view this League") — they were never made public.
 * Reading them needs the cookies of a logged-in league member. They are used
 * here only, at fetch time, on your machine; the deployed static site has no
 * ESPN dependency at all.
 */
async function loadEnvLocal(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, '..', 'data', 'raw');

await loadEnvLocal(join(__dirname, '..', '.env.local'));

const LEAGUE_ID = process.env.ESPN_LEAGUE_ID ?? '264063';
// The league reports previousSeasons back to 2008 (see status.previousSeasons
// on any season payload). Seasons 2019+ are publicly readable; 2008-2018 are
// private and need cookies.
const FIRST_SEASON = Number(process.env.FIRST_SEASON ?? 2008);
const LAST_SEASON = Number(process.env.LAST_SEASON ?? new Date().getFullYear());

const VIEWS = ['mTeam', 'mSettings', 'mMatchup', 'mStandings'];

const cookies =
  process.env.ESPN_S2 && process.env.ESPN_SWID
    ? { espnS2: process.env.ESPN_S2, swid: process.env.ESPN_SWID }
    : null;

if (!cookies) {
  console.log(
    'No ESPN cookies found — seasons before 2019 are private and will 401.\n' +
      'Add ESPN_S2 and ESPN_SWID to .env.local to pull the full history.\n'
  );
}

await mkdir(RAW_DIR, { recursive: true });

console.log(`Fetching league ${LEAGUE_ID}, seasons ${FIRST_SEASON}-${LAST_SEASON}\n`);

const fetched = [];
const unauthorized = [];

for (let season = FIRST_SEASON; season <= LAST_SEASON; season++) {
  process.stdout.write(`  ${season}… `);
  try {
    const data = await fetchSeason(LEAGUE_ID, season, { views: VIEWS, cookies });
    if (!data) {
      console.log('not found');
      continue;
    }

    await writeFile(
      join(RAW_DIR, `${season}.json`),
      JSON.stringify(data, null, 2),
      'utf8'
    );

    const teams = data.teams?.length ?? 0;
    const games = data.schedule?.length ?? 0;
    console.log(`${teams} teams, ${games} matchups`);
    fetched.push(season);
  } catch (error) {
    if (error.status === 401) {
      // Distinct from "not found" on purpose: 401 means the season EXISTS but
      // is private. Conflating the two is how the history looked like it
      // started in 2019.
      unauthorized.push(season);
      console.log('private (401) — needs cookies');
    } else {
      console.log(`failed — ${error.message}`);
    }
  }
}

console.log(`\n✓ ${fetched.length} seasons written to data/raw/`);
console.log(`  ${fetched.join(', ')}`);

if (unauthorized.length) {
  console.log(
    `\n⚠ ${unauthorized.length} season(s) exist but are private: ${unauthorized.join(', ')}`
  );
  console.log(
    cookies
      ? '  Your cookies did not grant access — they may be stale. Re-copy them from a logged-in browser.'
      : '  Add ESPN_S2 and ESPN_SWID to .env.local to fetch them.'
  );
}

// Surface what the league itself claims, so a silent gap cannot go unnoticed.
const newest = fetched.at(-1);
if (newest) {
  const payload = JSON.parse(
    await readFile(join(RAW_DIR, `${newest}.json`), 'utf8')
  );
  const claimed = payload.status?.previousSeasons ?? [];
  if (claimed.length) {
    const expected = [...claimed, newest].sort((a, b) => a - b);
    const missing = expected.filter((s) => !fetched.includes(s));
    console.log(
      `\n  ESPN reports this league has played: ${expected[0]}-${expected.at(-1)} (${expected.length} seasons)`
    );
    if (missing.length) {
      console.log(`  Still missing: ${missing.join(', ')}`);
    } else {
      console.log('  Complete history captured.');
    }
  }
}
