/**
 * Everything a weekly writeup needs to be written from, gathered once.
 *
 * The quality of a generated writeup is almost entirely a function of what it
 * is handed. A model given the final scores writes a paragraph about the final
 * scores; a model given every bench point, every waiver move and who actually
 * rosters whom writes the thing people want to read.
 *
 * Every figure here comes from a primary source -- Sleeper for this season,
 * data/league.json for the eighteen before it, the database for points and the
 * Market. Nothing is computed twice in two places: the verification pass reads
 * the same sources independently, so if this file is wrong the checkers catch
 * it rather than inheriting the mistake.
 *
 * ROSTER OWNERSHIP IS NOT DECORATION. The first draft of the week 2 preview
 * read as though a manager's Market holdings were his own underperforming
 * lineup -- every number correct, the frame completely wrong, because the
 * context never said who actually started Ja'Marr Chase. `playerOwners` carries
 * the owning manager for exactly that reason.
 *
 * WHAT IS DELIBERATELY ABSENT: nobody's portfolio and nobody's point balance.
 * Those are private, the same way a bet is hidden until its market locks, and
 * for the same reason -- visible positions get copied. `bookState` returns
 * anonymous totals only. If you find yourself adding a name to it, the answer
 * is no.
 */
import { neon } from '@neondatabase/serverless';
import { SLEEPER_OWNERS } from './sleeper-owners.js';

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';
const API = 'https://api.sleeper.app/v1';

const api = (path) =>
  fetch(`${API}${path}`).then((r) => {
    if (!r.ok) throw new Error(`Sleeper ${path} returned ${r.status}`);
    return r.json();
  });

function sql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  return neon(process.env.DATABASE_URL);
}

const round = (n, p = 2) => (n == null ? null : Number(Number(n).toFixed(p)));

/** Sleeper's own idea of the current season and week. */
export async function nflState() {
  const s = await api('/state/nfl');
  return { season: Number(s.season), week: Number(s.week) };
}

/**
 * roster_id -> { team, manager, slug }.
 *
 * `team` is what shows on the board, `manager` the human. A writeup needs both:
 * "Token Effort" is the team and "Chris N" is who to make fun of.
 */
async function teams() {
  const [users, rosters] = await Promise.all([
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
  ]);
  const byUser = {};
  for (const u of users) byUser[u.user_id] = u;

  const out = {};
  for (const r of rosters) {
    const u = byUser[r.owner_id];
    const known = SLEEPER_OWNERS[r.owner_id];
    out[r.roster_id] = {
      rosterId: r.roster_id,
      team: u?.metadata?.team_name || u?.display_name || `Roster ${r.roster_id}`,
      manager: known?.name ?? u?.display_name ?? `Roster ${r.roster_id}`,
      slug: known?.slug ?? null,
      wins: r.settings?.wins ?? 0,
      losses: r.settings?.losses ?? 0,
      ties: r.settings?.ties ?? 0,
      pointsFor: round((r.settings?.fpts ?? 0) + (r.settings?.fpts_decimal ?? 0) / 100),
      pointsAgainst: round(
        (r.settings?.fpts_against ?? 0) + (r.settings?.fpts_against_decimal ?? 0) / 100,
      ),
      players: (r.players ?? []).map(String),
    };
  }
  return out;
}

/** Sleeper's player map, cached for the life of the process. */
let _players = null;
async function players() {
  if (!_players) _players = await fetch(`${API}/players/nfl`).then((r) => r.json());
  return _players;
}

/**
 * Who rosters whom, and who started them.
 *
 * The guard against the worst class of error a writeup can make: attributing a
 * player to the wrong manager. Keyed by player id so a checker can look up any
 * name the draft mentions.
 */
export async function playerOwners(week) {
  const [byRoster, ps, ms] = await Promise.all([teams(), players(), api(`/league/${LEAGUE_ID}/matchups/${week}`)]);
  const out = {};
  for (const m of ms) {
    const t = byRoster[m.roster_id];
    if (!t) continue;
    const starters = new Set((m.starters ?? []).map(String));
    for (const [pid, pts] of Object.entries(m.players_points ?? {})) {
      const p = ps[pid];
      out[String(pid)] = {
        name: p?.full_name ?? p?.last_name ?? String(pid),
        position: p?.position ?? null,
        nflTeam: p?.team ?? null,
        rosteredBy: t.manager,
        rosteredByTeam: t.team,
        started: starters.has(String(pid)),
        points: round(pts, 2),
      };
    }
  }
  return out;
}

/** One week of results: every matchup, every starter, every bench point. */
export async function weekResults(week) {
  const [byRoster, ps, ms] = await Promise.all([
    teams(),
    players(),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
  ]);

  const byMatchup = {};
  for (const m of ms) (byMatchup[m.matchup_id] ??= []).push(m);

  const line = (m) => {
    const t = byRoster[m.roster_id];
    const starters = (m.starters ?? []).map(String);
    const all = Object.entries(m.players_points ?? {});
    const named = ([pid, pts]) => ({
      name: ps[pid]?.full_name ?? ps[pid]?.last_name ?? String(pid),
      position: ps[pid]?.position ?? null,
      points: round(pts, 2),
    });
    return {
      rosterId: m.roster_id,
      team: t?.team,
      manager: t?.manager,
      points: round(m.points, 2),
      starters: all
        .filter(([pid]) => starters.includes(String(pid)))
        .map(named)
        .sort((a, b) => b.points - a.points),
      bench: all
        .filter(([pid]) => !starters.includes(String(pid)))
        .map(named)
        .sort((a, b) => b.points - a.points),
    };
  };

  const games = [];
  for (const side of Object.values(byMatchup)) {
    if (side.length < 2) continue;
    const [a, b] = side.map(line);
    const [win, lose] = a.points >= b.points ? [a, b] : [b, a];
    games.push({
      home: a,
      away: b,
      winner: win.manager,
      loser: lose.manager,
      margin: round(Math.abs(a.points - b.points), 2),
    });
  }
  return games.sort((x, y) => y.margin - x.margin);
}

/** Who plays whom next, with the model's own projection and price. */
export async function weekPreview(season, week) {
  const [byRoster, { liveMatchups }] = await Promise.all([teams(), import('./live.js')]);
  const state = await liveMatchups(season, week);
  const out = [];
  for (const g of Object.values(state.matchups ?? {})) {
    out.push({
      home: { team: g.homeName, manager: byRoster[g.homeRoster]?.manager, projected: round(g.home?.projected, 1) },
      away: { team: g.awayName, manager: byRoster[g.awayRoster]?.manager, projected: round(g.away?.projected, 1) },
      homeWinProbability: round(g.probability, 3),
      odds: g.odds,
    });
  }
  return out;
}

/** Adds and drops since the last writeup, which is where the jokes live. */
export async function transactions(week) {
  const [byRoster, ps] = await Promise.all([teams(), players()]);
  const rows = await api(`/league/${LEAGUE_ID}/transactions/${week}`).catch(() => []);
  const name = (pid) => ps[pid]?.full_name ?? ps[pid]?.last_name ?? String(pid);
  return rows
    .filter((t) => t.status === 'complete')
    .map((t) => ({
      type: t.type,
      managers: (t.roster_ids ?? []).map((id) => byRoster[id]?.manager).filter(Boolean),
      added: Object.keys(t.adds ?? {}).map(name),
      dropped: Object.keys(t.drops ?? {}).map(name),
    }));
}

/**
 * The eighteen years before Sleeper: career records and the head-to-head for
 * each of the coming week's matchups.
 *
 * Head-to-head rows in league.json are REGULAR SEASON ONLY. A writeup that
 * calls one "lifetime" is overstating it, so both figures are returned and
 * labelled.
 */
export async function history(matchups) {
  const { default: league } = await import('../data/league.json', { with: { type: 'json' } });
  const bySlug = {};
  for (const o of league.owners) bySlug[o.slug] = o;
  const slugOf = {};
  for (const v of Object.values(SLEEPER_OWNERS)) slugOf[v.name] = v.slug;

  const pairFacts = (aName, bName) => {
    const a = slugOf[aName];
    const b = slugOf[bName];
    if (!a || !b) return null;
    const row = league.headToHead.find((r) => r.a === a && r.b === b);
    const games = league.games.filter(
      (g) => (g.home === a && g.away === b) || (g.home === b && g.away === a),
    );
    let w = 0, l = 0, pw = 0, pl = 0, biggest = null;
    for (const g of games) {
      const mine = g.home === a ? g.homePoints : g.awayPoints;
      const theirs = g.home === a ? g.awayPoints : g.homePoints;
      if (mine > theirs) { w++; if (g.isPlayoff) pw++; }
      else if (theirs > mine) { l++; if (g.isPlayoff) pl++; }
      const margin = Math.abs(g.homePoints - g.awayPoints);
      if (!biggest || margin > biggest.margin) biggest = { ...g, margin: round(margin, 1) };
    }
    const recent = [...games].sort((x, y) => y.season - x.season || y.week - x.week)[0] ?? null;
    return {
      regularSeason: row ? `${row.wins}-${row.losses} over ${row.games}` : 'none',
      allTimeIncludingPlayoffs: `${w}-${l} over ${games.length}`,
      playoffRecord: `${pw}-${pl}`,
      biggestBlowout: biggest,
      mostRecent: recent,
      careers: {
        [aName]: career(bySlug[a]),
        [bName]: career(bySlug[b]),
      },
    };
  };

  const career = (o) =>
    o
      ? {
          record: `${o.wins}-${o.losses}`,
          gamesOverFiveHundred: o.wins - o.losses,
          championships: o.championships,
          lastSeason: o.seasons?.at(-1) ?? null,
          highestScore: o.highestScore,
          lowestScore: o.lowestScore,
        }
      : null;

  const out = {};
  for (const m of matchups) {
    const key = `${m.home.manager} vs ${m.away.manager}`;
    out[key] = pairFacts(m.home.manager, m.away.manager);
  }
  return out;
}

/**
 * What the Market is doing, with nobody's positions in it.
 *
 * WHO HOLDS WHAT IS PRIVATE, for the same reason bets are hidden until a market
 * locks: if everyone can see the portfolios, everyone copies the portfolios, and
 * the game becomes ten people owning the same four players. The app has always
 * enforced this -- every holdings query in lib/market/trading.js is scoped to
 * the signed-in owner, and the watchlist's "own N" is only ever your own count.
 *
 * A writeup is the one place that rule could be broken by accident, because a
 * writeup sees the whole database and speaks to the whole league. The week 2
 * preview did exactly that on 2026-09-16: it named a manager, his share counts
 * and the players he had bought. So the aggregate never leaves this function
 * with a name attached to it.
 *
 * Totals are fine and worth writing about -- how many people are trading, how
 * concentrated the market is, what the dividends looked like. Those describe the
 * game without handing anyone else's homework over.
 */
export async function bookState(season) {
  const db = sql();
  const [holdings, ps] = await Promise.all([
    db`select owner, player_id, shares from market_holdings
       where season = ${season} and shares > 0`,
    players(),
  ]);

  const traders = new Set(holdings.map((h) => h.owner));
  const byPlayer = {};
  for (const h of holdings) {
    const name = ps[h.player_id]?.full_name ?? String(h.player_id);
    byPlayer[name] = (byPlayer[name] ?? 0) + Number(h.shares);
  }
  const totalShares = holdings.reduce((n, h) => n + Number(h.shares), 0);
  const mostHeld = Object.entries(byPlayer)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([player, shares]) => ({ player, shares }));

  return {
    // Deliberately anonymous. Do not add names here.
    marketSummary: {
      tradersActive: traders.size,
      totalShares,
      mostHeldPlayers: mostHeld,
      note:
        'Individual portfolios and point balances are private, like bets before a ' +
        'market locks. Never attribute a holding, a share count or a points total ' +
        'to a named manager.',
    },
  };
}

/**
 * The whole picture for one writeup.
 *
 * `kind` is 'recap' (the week that just finished) or 'preview' (the one about
 * to start). A recap leads with results; a preview leads with matchups. Both
 * get everything, because the interesting line is usually the one that crosses
 * between them.
 */
export async function buildWriteupContext({ kind, season, week }) {
  const resultsWeek = kind === 'recap' ? week : week - 1;
  const previewWeek = kind === 'recap' ? week + 1 : week;

  const [standings, results, preview, moves, owners, book] = await Promise.all([
    teams(),
    resultsWeek >= 1 ? weekResults(resultsWeek) : [],
    weekPreview(season, previewWeek).catch(() => []),
    transactions(previewWeek).catch(() => []),
    resultsWeek >= 1 ? playerOwners(resultsWeek) : {},
    bookState(season).catch(() => null),
  ]);

  const hist = await history(preview).catch(() => ({}));

  return {
    kind,
    season,
    resultsWeek,
    previewWeek,
    standings: Object.values(standings)
      .map(({ players: _ignored, ...rest }) => rest)
      .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor),
    results,
    preview,
    transactions: moves,
    playerOwnership: owners,
    book,
    history: hist,
  };
}
