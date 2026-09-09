/**
 * Weekly achievement definitions.
 *
 * Every achievement is computed from Sleeper matchup data -- never asked for,
 * never estimated. Each returns a list of {slug, detail} winners; ties award
 * everyone who tied, because arbitrarily breaking a tie is worse than two
 * people sharing a badge.
 *
 * Points are tuned so decisions are worth more than luck: winning the week on
 * raw score is 3, but leaving the fewest points on your bench is 4, because one
 * is your roster and the other is you.
 */

export const CATEGORIES = { GOOD: 'good', PAIN: 'pain', BONUS: 'bonus' };

export const ACHIEVEMENTS = [
  // ---- core ----
  {
    id: 'top-score', name: 'Weekly High Score', icon: '👑', points: 3,
    category: CATEGORIES.GOOD,
    blurb: 'Most points scored in the league this week.',
    compute: (w) => best(w.teams, (t) => t.points).map((t) => ({ slug: t.slug, detail: `${t.points.toFixed(2)} pts` })),
  },
  {
    id: 'above-median', name: 'Beat the Median', icon: '📈', points: 1,
    category: CATEGORIES.GOOD,
    blurb: 'Scored above the league median. Half the league earns this every week.',
    compute: (w) => w.teams.filter((t) => t.points > w.median)
      .map((t) => ({ slug: t.slug, detail: `${t.points.toFixed(2)} vs ${w.median.toFixed(2)} median` })),
  },
  {
    id: 'biggest-margin', name: 'Biggest Beatdown', icon: '💥', points: 2,
    category: CATEGORIES.GOOD,
    blurb: 'Won by the largest margin this week.',
    compute: (w) => best(w.games, (g) => g.margin).map((g) => ({ slug: g.winnerSlug, detail: `won by ${g.margin.toFixed(2)}` })),
  },
  {
    id: 'top-player', name: 'Player of the Week', icon: '⭐', points: 2,
    category: CATEGORIES.GOOD,
    blurb: 'Started the highest-scoring player in the league.',
    compute: (w) => best(w.allStarters, (p) => p.points)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.points.toFixed(2)}` })),
  },
  {
    id: 'manager-of-week', name: 'Actually Set Your Lineup', icon: '🧠', points: 4,
    category: CATEGORIES.GOOD,
    blurb: 'Left the fewest points on the bench. The only award that is purely a decision.',
    compute: (w) => best(w.teams, (t) => -t.benchPoints)
      .map((t) => ({ slug: t.slug, detail: `only ${t.benchPoints.toFixed(2)} left on bench` })),
  },

  // ---- pain ----
  {
    id: 'low-score', name: 'Bottom of the Barrel', icon: '🗑️', points: -2,
    category: CATEGORIES.PAIN,
    blurb: 'Lowest score in the league this week.',
    compute: (w) => best(w.teams, (t) => -t.points).map((t) => ({ slug: t.slug, detail: `${t.points.toFixed(2)} pts` })),
  },
  {
    id: 'worst-bench', name: 'Should Have Started Him', icon: '🤡', points: -2,
    category: CATEGORIES.PAIN,
    blurb: 'Biggest single start/sit mistake, comparing players at the same position.',
    compute: (w) => {
      const withMiss = w.teams.filter((t) => t.worstBenchMistake);
      return best(withMiss, (t) => t.worstBenchMistake.swing).map((t) => ({
        slug: t.slug,
        detail: `benched ${t.worstBenchMistake.benched} (${t.worstBenchMistake.benchedPoints}) for ${t.worstBenchMistake.started} (${t.worstBenchMistake.startedPoints})`,
      }));
    },
  },
  {
    id: 'unluckiest', name: 'Nice Score, Still Lost', icon: '😤', points: 1,
    category: CATEGORIES.PAIN,
    blurb: 'Highest-scoring loser of the week. Worth a point because it was not your fault.',
    compute: (w) => {
      const losers = w.games.map((g) => ({ slug: g.loserSlug, points: g.loserPoints }));
      return best(losers, (l) => l.points).map((l) => ({ slug: l.slug, detail: `${l.points.toFixed(2)} and still lost` }));
    },
  },

  // ---- bonus ----
  {
    id: 'giant-killer', name: 'Giant Killer', icon: '🗡️', points: 3,
    category: CATEGORIES.BONUS,
    blurb: 'Beat a team with a better record coming into the week.',
    compute: (w) => w.games.filter((g) => g.upset)
      .map((g) => ({ slug: g.winnerSlug, detail: `beat ${g.loserName} (${g.loserRecordBefore})` })),
  },
  {
    id: 'hot-streak', name: 'On a Heater', icon: '🔥', points: 2,
    category: CATEGORIES.BONUS,
    blurb: 'Won three or more in a row.',
    compute: (w) => w.teams.filter((t) => t.winStreak >= 3)
      .map((t) => ({ slug: t.slug, detail: `${t.winStreak} straight` })),
  },

  // ---- position awards ----
  ...['QB', 'RB', 'WR', 'TE'].map((pos) => ({
    id: `top-${pos.toLowerCase()}`, name: `Best ${pos}`, icon: positionIcon(pos), points: 1,
    category: CATEGORIES.BONUS,
    blurb: `Started the highest-scoring ${pos} in the league.`,
    compute: (w) => best(w.allStarters.filter((p) => p.position === pos), (p) => p.points)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.points.toFixed(2)}` })),
  })),
];

function positionIcon(pos) {
  return { QB: '🎯', RB: '🏃', WR: '🙌', TE: '🧱' }[pos] ?? '⭐';
}

/** Every item tied for the max of `score`. Empty input yields no winners. */
function best(items, score) {
  if (!items?.length) return [];
  const top = Math.max(...items.map(score));
  if (!Number.isFinite(top)) return [];
  return items.filter((i) => score(i) === top);
}

export const byId = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));
