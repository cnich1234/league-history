/**
 * Writes a slim public/players.json for the live gameday view.
 *
 * Sleeper's full player file is ~15MB, which is unshippable to a phone. Only
 * name and position are needed to render live scoring, and only for players on
 * a roster in this league -- that turns 12k players into a few hundred.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
const SRC = 'C:/Users/chris/fantasy/draft-tool/data/sleeper-players.json';

const rosters = await fetch(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`).then((r) => r.json());
const owned = new Set(rosters.flatMap((r) => r.players ?? []));

const all = JSON.parse(readFileSync(SRC, 'utf8'));
const slim = {};
for (const id of owned) {
  const p = all[id];
  if (!p) continue;
  slim[id] = { n: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(), p: p.position ?? '?' };
}

writeFileSync('public/players.json', JSON.stringify(slim));
const kb = (JSON.stringify(slim).length / 1024).toFixed(1);
console.log(`public/players.json: ${Object.keys(slim).length} rostered players, ${kb} KB`);
