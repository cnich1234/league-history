/**
 * Imports the hand-captured pre-2019 schedule dumps into data/raw/.
 *
 * Seasons 2008-2018 are private and unreachable from a script — every endpoint
 * variant returns 401/404 even with valid cookies — but the logged-in browser
 * can read them via `view=mMatchupScore`. Those responses are pasted into a
 * text file, one block per season, and imported here.
 *
 * The file format is forgiving on purpose: a bare year on its own line,
 * followed by the JSON array that ESPN returned. The seasonId inside the JSON
 * wins if it disagrees with the header.
 *
 *   node scripts/import-schedules.mjs <path-to-file>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = join(__dirname, '..', 'data', 'raw');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/import-schedules.mjs <file>');
  process.exit(1);
}

const text = await readFile(source, 'utf8');

/**
 * Pull out every top-level JSON array by bracket matching. Splitting on the
 * year headers would be fragile — the payloads contain years too.
 */
function extractJsonArrays(input) {
  const found = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== '[') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < input.length; j++) {
      const ch = input[j];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          found.push(input.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return found;
}

await mkdir(RAW_DIR, { recursive: true });

const blocks = extractJsonArrays(text);
console.log(`Found ${blocks.length} JSON block(s)\n`);

const imported = [];
const problems = [];

for (const block of blocks) {
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    problems.push(`unparseable block (${block.length} chars): ${error.message}`);
    continue;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];

  for (const entry of entries) {
    const season = Number(entry.seasonId);
    if (!season) {
      problems.push('block with no seasonId');
      continue;
    }

    const schedule = entry.schedule ?? [];
    const played = schedule.filter(
      (game) => (game.home?.totalPoints ?? 0) > 0 || (game.away?.totalPoints ?? 0) > 0
    );

    if (played.length === 0) {
      problems.push(`${season}: no completed games in schedule`);
      continue;
    }

    // Merge onto whatever we already have for that season: the standings dump
    // carries team records and final ranks that this payload may lack.
    const path = join(RAW_DIR, `${season}.json`);
    let existing = null;
    try {
      existing = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      /* first write for this season */
    }

    const merged = {
      ...(existing ?? {}),
      ...entry,
      // Prefer whichever source actually has teams with records.
      teams: pickTeams(existing?.teams, entry.teams),
      schedule,
      __source: existing?.__source
        ? `${existing.__source}+mMatchupScore`
        : 'mMatchupScore',
    };

    await writeFile(path, JSON.stringify(merged, null, 2), 'utf8');
    imported.push({ season, games: played.length, teams: merged.teams?.length ?? 0 });
  }
}

/** Keep the team list that carries win/loss records. */
function pickTeams(existingTeams, incomingTeams) {
  const hasRecords = (teams) =>
    (teams ?? []).some(
      (team) =>
        (team.record?.overall?.wins ?? 0) + (team.record?.overall?.losses ?? 0) > 0
    );
  if (hasRecords(existingTeams)) return existingTeams;
  if (hasRecords(incomingTeams)) return incomingTeams;
  return existingTeams ?? incomingTeams ?? [];
}

imported.sort((a, b) => a.season - b.season);
for (const row of imported) {
  console.log(`  ${row.season}: ${row.games} games, ${row.teams} teams`);
}

console.log(`\n✓ ${imported.length} season(s) imported`);
if (problems.length) {
  console.log('\n⚠ Issues:');
  for (const problem of problems) console.log(`   - ${problem}`);
}
