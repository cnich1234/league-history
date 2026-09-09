import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACHIEVEMENTS, byId } from '../scripts/achievements.mjs';

const FILE = join(process.cwd(), 'data', 'weekly.json');

/** Empty shape when no week has been scored yet, so pages render a real
 *  "nothing here yet" state instead of crashing on a missing file. */
const EMPTY = { weeks: [], season: [] };

export function getWeekly() {
  if (!existsSync(FILE)) return EMPTY;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return EMPTY;
  }
}

export function getWeek(n) {
  return getWeekly().weeks.find((w) => w.week === Number(n)) ?? null;
}

export { ACHIEVEMENTS, byId };
