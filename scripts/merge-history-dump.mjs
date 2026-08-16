/**
 * Merges the `kona_history_standings` dump into data/raw/.
 *
 * Seasons 2008-2018 are private and cannot be fetched with cookies from a
 * script — ESPN returns 401/404 for them on every endpoint variant, yet the
 * logged-in web UI reads them fine via:
 *
 *   leagueHistory/{id}?view=kona_history_standings&platformVersion=...
 *
 * So those seasons are captured once by hand from the browser console and
 * dropped in as data/history-dump.json. This script splits that array into the
 * same per-season files fetch-history.mjs writes, WITHOUT clobbering the richer
 * payloads we can fetch directly for 2019+.
 *
 * The dump is standings-only: it has team records and final ranks, but no
 * schedule. Head-to-head therefore stays limited to the seasons we can fetch in
 * full; season records and championships cover all 18.
 *
 *   node scripts/merge-history-dump.mjs
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RAW_DIR = join(DATA_DIR, 'raw');
const DUMP_PATH = join(DATA_DIR, 'history-dump.json');

const dump = JSON.parse(await readFile(DUMP_PATH, 'utf8'));
if (!Array.isArray(dump)) {
  console.error('history-dump.json must be the JSON array returned by the browser.');
  process.exit(1);
}

await mkdir(RAW_DIR, { recursive: true });
const existing = new Set(
  (await readdir(RAW_DIR)).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
);

let written = 0;
let skipped = 0;

for (const season of dump) {
  const year = String(season.seasonId);
  if (!year || year === 'undefined') continue;

  // Never overwrite a full fetch: those carry schedule + members, which the
  // standings dump lacks.
  if (existing.has(year)) {
    skipped++;
    continue;
  }

  // Mark provenance so build-stats can tell which seasons lack a schedule.
  const payload = { ...season, __source: 'kona_history_standings' };
  await writeFile(join(RAW_DIR, `${year}.json`), JSON.stringify(payload, null, 2), 'utf8');
  written++;
}

console.log(`✓ ${written} season(s) written from the dump`);
console.log(`  ${skipped} skipped (already fetched in full)`);

const all = (await readdir(RAW_DIR))
  .filter((f) => f.endsWith('.json'))
  .map((f) => Number(f.replace('.json', '')))
  .sort((a, b) => a - b);
console.log(`  raw/ now covers ${all[0]}-${all.at(-1)} (${all.length} seasons)`);
