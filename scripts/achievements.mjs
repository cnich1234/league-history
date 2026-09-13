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
    blurb: 'Left the fewest startable points on the bench. The one award that is purely a decision.',
    // Counts only players who PLAYED and could have replaced someone weaker at
    // the same position. It used to use raw bench points, which meant a manager
    // whose bench was two injured players and a bye won by having nothing to
    // leave -- rewarding a thin roster rather than a good decision.
    compute: (w) => best(w.teams, (t) => -(t.missedPoints ?? 0))
      .map((t) => ({
        slug: t.slug,
        detail: (t.missedPoints ?? 0) === 0
          ? 'perfect lineup'
          : `only ${(t.missedPoints ?? 0).toFixed(2)} startable points missed`,
      })),
  },

  // ---- consolation ----
  //
  // Nothing here is negative. Points buy boosts in The Book, and taking them
  // away from the manager already losing on the field would compound a bad
  // season into a bad season with nothing to do about it. These pay the bottom
  // of the table instead, and none of them correlate with winning.
  {
    id: 'low-score', name: 'Bottom of the Barrel', icon: '🗑️', points: 2,
    category: CATEGORIES.PAIN,
    blurb: 'Lowest score in the league. Consolation, because that is a rough week.',
    compute: (w) => best(w.teams, (t) => -t.points).map((t) => ({ slug: t.slug, detail: `${t.points.toFixed(2)} pts` })),
  },
  {
    id: 'unluckiest', name: 'Nice Score, Still Lost', icon: '😤', points: 2,
    category: CATEGORIES.PAIN,
    blurb: 'Highest-scoring loser of the week. Worth a point because it was not your fault.',
    compute: (w) => {
      const losers = w.games.map((g) => ({ slug: g.loserSlug, points: g.loserPoints }));
      return best(losers, (l) => l.points).map((l) => ({ slug: l.slug, detail: `${l.points.toFixed(2)} and still lost` }));
    },
  },
  {
    id: 'close-loss', name: 'So Close', icon: '💔', points: 2,
    category: CATEGORIES.PAIN,
    blurb: 'Lost by less than 3 points.',
    compute: (w) => w.games.filter((g) => g.margin < 3)
      .map((g) => ({ slug: g.loserSlug, detail: `lost by ${g.margin.toFixed(2)}` })),
  },
  {
    id: 'beat-projection', name: 'Overachiever', icon: '🚀', points: 1,
    category: CATEGORIES.PAIN,
    blurb: 'Scored more than you were projected to. A bad team does this as often as a good one.',
    // One point, not two. This and beat-spread both fire about half of all
    // weeks, so at 2 each they were 35% of every point earned in the league --
    // two near-duplicate awards ("you did better than expected") drowning out
    // everything else. At 1 they read as the participation bonuses they are.
    // Deliberately uncorrelated with the standings: it compares you to your own
    // expectation rather than to the league, so it is a genuine floor for
    // someone having a terrible season.
    compute: (w) => w.teams
      .filter((t) => t.projected != null && t.points > t.projected)
      .map((t) => ({
        slug: t.slug,
        detail: `${t.points.toFixed(2)} vs ${t.projected.toFixed(2)} projected`,
      })),
  },
  {
    id: 'beat-spread', name: 'Beat the Spread', icon: '⚖️', points: 1,
    category: CATEGORIES.PAIN,
    blurb: 'Did better than the projected margin -- win or lose.',
    // The best of the consolation awards, because losing does not disqualify
    // you: a team projected to lose by 25 that loses by 8 earns it. Completely
    // decoupled from record.
    compute: (w) => w.games.flatMap((g) =>
      (g.sides ?? [])
        .filter((s) => s.expectedMargin != null && s.actualMargin > s.expectedMargin)
        .map((s) => ({
          slug: s.slug,
          detail: s.actualMargin >= 0
            ? `won by ${s.actualMargin.toFixed(2)}, projected ${s.expectedMargin.toFixed(2)}`
            : `lost by ${Math.abs(s.actualMargin).toFixed(2)}, projected to lose by ${Math.abs(s.expectedMargin).toFixed(2)}`,
        })),
    ),
  },

  {
    id: 'lucky-win', name: 'Ugly Win', icon: '🐗', points: 2,
    category: CATEGORIES.PAIN,
    blurb: 'Won the week with the lowest score of anyone who won.',
    // The mirror of Nice Score Still Lost: you were bad and got away with it.
    compute: (w) => {
      const winners = w.games.map((g) => ({ slug: g.winnerSlug, points: g.winnerPoints }));
      return best(winners, (x) => -x.points).map((x) => ({
        slug: x.slug,
        detail: `won with only ${x.points.toFixed(2)}`,
      }));
    },
  },
  {
    id: 'over-projection', name: 'Blew It Away', icon: '📊', points: 2,
    category: CATEGORIES.PAIN,
    blurb: 'Beat your projection by the most points in the league.',
    // Distinct from Overachiever, which pays EVERYONE who beat their number.
    // This is the single biggest overperformance, so exactly one winner.
    compute: (w) => {
      const over = w.teams
        .filter((t) => t.projected != null)
        .map((t) => ({ slug: t.slug, by: t.points - t.projected, points: t.points, projected: t.projected }))
        .filter((t) => t.by > 0);
      return best(over, (t) => t.by).map((t) => ({
        slug: t.slug,
        detail: `${t.points.toFixed(2)} vs ${t.projected.toFixed(2)} projected (+${t.by.toFixed(2)})`,
      }));
    },
  },

  // ---- bonus ----
  {
    id: 'giant-killer', name: 'Giant Killer', icon: '🗡️', points: 2,
    category: CATEGORIES.BONUS,
    blurb: 'Beat a team with a better record coming into the week.',
    // Was 3, which made it the single biggest earner in the game -- it fires
    // about 18% of weeks per manager rather than the 10% a one-winner award
    // does, because early-season records are lopsided and a 0-1 team beating a
    // 1-0 team qualifies. Still generous at 2, and it favours weaker teams,
    // which is the point.
    compute: (w) => w.games.filter((g) => g.upset)
      .map((g) => ({ slug: g.winnerSlug, detail: `beat ${g.loserName} (${g.loserRecordBefore})` })),
  },
  {
    id: 'hot-streak', name: 'On a Heater', icon: '🔥', points: 3,
    category: CATEGORIES.BONUS,
    blurb: 'Won three or more in a row.',
    compute: (w) => w.teams.filter((t) => t.winStreak >= 3)
      .map((t) => ({ slug: t.slug, detail: `${t.winStreak} straight` })),
  },
  {
    id: 'big-week', name: 'Put Up 180', icon: '💯', points: 5,
    category: CATEGORIES.BONUS,
    blurb: 'Scored 180 or more. Happens a couple of times a season, league-wide.',
    // 200 was the first instinct and it is essentially mythical: at this
    // league's fitted mean of 120 and SD of 28, a 200-point week happens 0.3
    // times per SEASON across all ten managers. 180 lands about twice a season,
    // which is rare enough to feel special and common enough to exist.
    compute: (w) => w.teams.filter((t) => t.points >= 180)
      .map((t) => ({ slug: t.slug, detail: `${t.points.toFixed(2)} pts` })),
  },
  {
    id: 'wr-150', name: 'Receiving Clinic', icon: '🎪', points: 3,
    category: CATEGORIES.BONUS,
    blurb: 'Started a receiver who went for 150+ receiving yards.',
    // 250 was the original threshold and it happened ZERO times in all of
    // 2025 -- the best single game was 200. 150 happens about once per NFL
    // week, and then only counts if someone in this league started him.
    compute: (w) => w.allStarters.filter((p) => (p.recYards ?? 0) >= 150)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.recYards} rec yds` })),
  },
  {
    id: 'rb-150', name: 'Ground and Pound', icon: '🚜', points: 3,
    category: CATEGORIES.BONUS,
    blurb: 'Started a back who ran for 150+ yards.',
    // 200+ rushing happened 5 times in 17 weeks of 2025. 150 happened 16 times,
    // which is roughly once an NFL week before filtering to rostered players.
    compute: (w) => w.allStarters.filter((p) => (p.rushYards ?? 0) >= 150)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.rushYards} rush yds` })),
  },

  {
    id: 'bench-beats-lineup', name: 'Wrong Nine', icon: '🙃', points: 10,
    category: CATEGORIES.BONUS,
    blurb: 'Your bench outscored your starters.',
    // Worth 10 because it is genuinely rare: across all 150 team-weeks of the
    // 2025 season it happened exactly ZERO times, with starters averaging 134
    // against a bench of 39. If someone manages it they have earned the points.
    compute: (w) => w.teams
      .filter((t) => t.benchPoints != null && t.benchPoints > t.points)
      .map((t) => ({
        slug: t.slug,
        detail: `bench ${t.benchPoints.toFixed(2)} beat starters ${t.points.toFixed(2)}`,
      })),
  },
  {
    id: 'perfect-lineup', name: 'Perfect Lineup', icon: '💎', points: 4,
    category: CATEGORIES.BONUS,
    blurb: 'Nobody on your bench could have scored more than a starter you played.',
    // The strict version of Actually Set Your Lineup: not "fewest points
    // missed" but none at all. Measured on startable players only, so an
    // injured or bye-week bench does not hand it to you.
    compute: (w) => w.teams
      .filter((t) => t.missedPoints != null && t.missedPoints === 0)
      .map((t) => ({ slug: t.slug, detail: 'nothing left on the bench' })),
  },
  {
    id: 'negative-defense', name: 'Defenceless', icon: '🚨', points: 2,
    category: CATEGORIES.BONUS,
    blurb: 'Started a defence that finished on negative points.',
    // Happens about 2.2 times per NFL week, so with ten started defences this
    // fires most weeks for somebody. Consolation rather than mockery.
    compute: (w) => w.allStarters
      .filter((p) => p.position === 'DEF' && p.points < 0)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.points.toFixed(2)}` })),
  },

  {
    id: 'made-a-trade', name: 'Wheeler Dealer', icon: '🤝', points: 10,
    category: CATEGORIES.BONUS,
    blurb: 'Completed a trade this week.',
    // Worth a lot on purpose: trades are the thing a quiet league does least,
    // and both sides get paid. Everyone involved earns it, not just whoever
    // proposed it.
    compute: (w) => (w.traded ?? []).map((slug) => ({ slug, detail: 'made a trade' })),
  },
  {
    id: 'best-pickup', name: 'Waiver Wire Genius', icon: '🎣', points: 2,
    category: CATEGORIES.BONUS,
    blurb: 'Your waiver pickup outscored every other pickup this week.',
    // Must have been STARTED. Claiming someone and leaving them on the bench
    // was not a decision that paid off, so it does not count.
    compute: (w) => {
      const started = new Map(
        (w.allStarters ?? []).map((p) => [`${p.slug}:${p.id ?? p.name}`, p]),
      );
      const candidates = (w.pickups ?? [])
        .map((p) => {
          const player = (w.allStarters ?? []).find(
            (s) => s.slug === p.slug && String(s.id) === String(p.playerId),
          );
          return player ? { slug: p.slug, name: player.name, points: player.points } : null;
        })
        .filter(Boolean);
      return best(candidates, (c) => c.points).map((c) => ({
        slug: c.slug,
        detail: `${c.name} ${c.points.toFixed(2)} off waivers`,
      }));
    },
  },

  // ---- position awards ----
  ...['QB', 'RB', 'WR', 'TE'].map((pos) => ({
    id: `top-${pos.toLowerCase()}`, name: `Best ${pos}`, icon: positionIcon(pos), points: 1,
    category: CATEGORIES.BONUS,
    blurb: `Started the highest-scoring ${pos} in the league.`,
    compute: (w) => best(w.allStarters.filter((p) => p.position === pos), (p) => p.points)
      .map((p) => ({ slug: p.slug, detail: `${p.name} ${p.points.toFixed(2)}` })),
  })),

  // Started the WORST at a position. A consolation, not a fine -- nothing in
  // this list takes points away any more.
  ...['QB', 'RB', 'WR', 'TE'].map((pos) => ({
    id: `worst-${pos.toLowerCase()}`, name: `Worst ${pos}`, icon: worstIcon(pos), points: 1,
    category: CATEGORIES.PAIN,
    blurb: `Started the lowest-scoring ${pos} in the league.`,
    // Needs a real field. With only one started player at a position, the same
    // person would win Best and Worst in the same week, which is nonsense.
    compute: (w) => {
      // Only starters who PLAYED. A zero from a bye, an inactive, or a game
      // not yet kicked off is an absence, not the worst score in the league
      // -- and mid-week it made every unplayed starter a tie for worst, so
      // one manager could collect this twice.
      const atPos = w.allStarters.filter((p) => p.position === pos && p.played);
      if (atPos.length < 2) return [];
      return best(atPos, (p) => -p.points).map((p) => ({
        slug: p.slug,
        detail: `${p.name} ${p.points.toFixed(2)}`,
      }));
    },
  })),
];

function worstIcon(pos) {
  return { QB: '🥴', RB: '🐢', WR: '🧤', TE: '🪨' }[pos] ?? '🫠';
}

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

/**
 * Not started means not in the running.
 *
 * Every award compares teams, games or players, and mid-week a team that has
 * not played yet looks exactly like one that scored zero: it "wins" its game
 * because the other side is also at zero, holds the league low, has a
 * perfect lineup because nothing was startable, and ties every unplayed
 * starter for Best TE. One rule instead of fourteen conditions:
 *
 *   - a team is a candidate once any of its starters has played
 *   - a game exists once both sides have started
 *   - a player is a candidate once they have played
 *
 * Applied to the context before the awards run. On a finished week every
 * team has started, so it changes nothing; live, it makes the strip honest.
 */
export function inTheRunning(ctx) {
  const played = (ctx.allStarters ?? []).filter((p) => p.played);
  const started = new Set(played.map((p) => p.slug));
  const teams = (ctx.teams ?? []).filter((t) => started.has(t.slug));
  const games = (ctx.games ?? []).filter(
    (g) => started.has(g.winnerSlug) && started.has(g.loserSlug),
  );
  const scores = teams.map((t) => t.points).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median = !scores.length
    ? 0
    : scores.length % 2
      ? scores[mid]
      : (scores[mid - 1] + scores[mid]) / 2;
  return { ...ctx, teams, games, allStarters: played, median };
}

