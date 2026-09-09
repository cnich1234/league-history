// Maps Sleeper user ids to the historical identities in league-history/data/league.json.
//
// Resolved from three independent signals, then confirmed by Chris on 2026-09-09:
//   - handle match           ethiopian123, kmalina, chadr39 -> chad39, Debo66 -> SteelBall66
//   - 2025 team name carry-over  "fuck yo shit" -> fuckyoshit, "Gronkey Punch" -> mbrown10457
//   - recurring team-name bit    Ernie's "I Cashed @ WSOP x N" increments every year
//
// MiOK and iStingray had no handle or team-name link and were resolved by
// elimination; both were explicitly confirmed rather than left as guesses,
// because the generator writes career stats and championship years as fact.
//
// `slug` keys into league.json owners. All ten are mapped, so a null lookup here
// means a new manager joined and the prompt must be given no lore rather than
// inventing some.
export const SLEEPER_OWNERS = {
  '472291702070046720': { slug: 'chris-nicholson', name: 'Chris',  handle: 'ethiopian123' },
  '472295567045685248': { slug: 'devin-nicholson', name: 'Devin',  handle: 'Debo66' },
  '472297639564537856': { slug: 'kevin-malina',    name: 'Kevin',  handle: 'kmalina' },
  '472321693545656320': { slug: 'ernie-rossi',     name: 'Ernie',  handle: 'ErnieRossi' },
  '472498516594257920': { slug: 'brandon-lowe',    name: 'Brandon',handle: 'fuckyoshit' },
  '472668369321979904': { slug: 'austin-kobe',     name: 'Austin', handle: 'Bishopak87' },
  '473208694738251776': { slug: 'mike-rossi',      name: 'Mike R', handle: 'MiOK' },
  // Chris Rossi, not Chris Carmichael. Carmichael left after 2024 and was
  // replaced by Rossi, whose only prior season is 2025 ("Promised Consort
  // Rossi", 6-9). Elimination originally matched the wrong Chris and the
  // generator published Carmichael's 2-13 and 2023 title as Rossi's.
  '473253173725753344': { slug: 'chris-rossi',    name: 'Chris R', handle: 'iStingray' },
  '601641660610318336': { slug: 'chad-rissland',   name: 'Chad',   handle: 'chadr39' },
  '865356373146329088': { slug: 'mike-brown',      name: 'Mike B', handle: 'mbrown10457' },
};
