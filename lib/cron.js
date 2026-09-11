import { readFileSync, existsSync } from 'node:fs';
import { h2hProbability, twoWayOdds, fieldOdds, LEAGUE_SD } from './odds.js';
import { teamGameDates, lockTimeFor, lockInstantFor } from './schedule.js';
import { resolveMarket } from './settle.js';
import { settleMarket } from './book.js';
import { SLEEPER_OWNERS } from './sleeper-owners.js';

/**
 * Market building and settling, callable from a serverless function.
 *
 * The CLI scripts do the same work, but they read the 15MB Sleeper player file
 * from disk and take `process.argv`. Neither survives a deploy, so the logic
 * lives here and the scripts stay as the manual escape hatch.
 */

const LEAGUE_ID = process.env.SLEEPER_LEAGUE_ID ?? '1389735198932877312';

/**
 * P(margin < x) for a matchup, in points.
 *
 * Blowout markets need the probability of each TAIL separately -- "wins by more
 * than 20" for each side -- which h2hProbability cannot express, since it only
 * answers "who wins". Same distribution: the difference of two lineup scores,
 * sd = LEAGUE_SD * sqrt(2).
 */
function normalCdfFor(points) {
  const z = points / (LEAGUE_SD * Math.SQRT2) / Math.SQRT2;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

const api = async (path) => {
  const r = await fetch(`https://api.sleeper.app/v1${path}`);
  if (!r.ok) throw new Error(`Sleeper ${path} -> ${r.status}`);
  return r.json();
};

/**
 * Position and NFL team for the players on a roster.
 *
 * The full Sleeper player file is ~15MB and cannot ship in a serverless bundle,
 * so this reads the slim public/players.json the live view already uses and
 * falls back to fetching only what is missing.
 */
async function loadPlayerIndex() {
  const local = 'public/players.json';
  if (existsSync(local)) {
    try {
      const slim = JSON.parse(readFileSync(local, 'utf8'));
      // The slim file has name and position but not NFL team, which lock times
      // need. Fetch teams separately -- one small request, not fifteen megabytes.
      return slim;
    } catch {}
  }
  return {};
}

async function loadProjections(season, week) {
  const url =
    `https://api.sleeper.com/projections/nfl/${season}/${week}` +
    `?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE` +
    `&position[]=K&position[]=DEF&order_by=pts_ppr`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`projections -> ${res.status}`);
  const byId = {};
  const teamById = {};
  for (const r of await res.json()) {
    if (!r.player_id) continue;
    if (typeof r?.stats?.pts_ppr === 'number') byId[r.player_id] = r.stats.pts_ppr;
    // The projections payload carries the player's team, which is all the lock
    // calculation needs -- no separate player file required.
    if (r?.player?.team) teamById[r.player_id] = r.player.team;
    else if (r?.team) teamById[r.player_id] = r.team;
  }
  return { projections: byId, teams: teamById };
}

const BASELINE = { QB: 16, RB: 10, WR: 9, TE: 7, K: 8, DEF: 7 };

/**
 * The lowest projection worth posting a prop on.
 *
 * Below this the line lands at 0.5 or 1.5 and the bet stops being about
 * football: it is "did this person dress", which anyone reading an injury
 * report wins for free. A bye week projects zero and is caught by the same
 * floor. 3 keeps the deep bench out while leaving genuine flier picks in.
 */
const PROP_FLOOR = 3;

/** Builds the week's markets. Existing markets are left untouched. */
export async function buildWeek(sql, season, week) {
  const [league, users, rosters, matchups] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    api(`/league/${LEAGUE_ID}/users`),
    api(`/league/${LEAGUE_ID}/rosters`),
    api(`/league/${LEAGUE_ID}/matchups/${week}`),
  ]);

  if (!matchups?.length) return { created: 0, skipped: 0, note: 'no matchups' };

  const [{ projections, teams: nflTeams }, gameDates, slim] = await Promise.all([
    loadProjections(season, week),
    teamGameDates(season, week),
    loadPlayerIndex(),
  ]);

  const latestGameDay = Object.values(gameDates).sort().pop();
  const fallbackLock = latestGameDay
    ? lockInstantFor(latestGameDay)
    : new Date(Date.now() + 86400e3);

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterById = Object.fromEntries(rosters.map((r) => [r.roster_id, r]));

  const positionOf = (id) => slim[id]?.p ?? '?';
  const nameOf = (id) => slim[id]?.n ?? String(id);
  /**
   * What a player is projected to score this week. Zero on a bye.
   *
   * Falling through to BASELINE for a bye player inflated every line they
   * touched -- a team total set 9 points too high, and a spread skewed toward
   * whichever side had fewer teams resting. Byes start in week 5 and hit four
   * or five teams at a time, so this is most of the season.
   *
   * `gameDates` covers every team with a game this week, so a rostered player
   * whose team is absent from it is on a bye. A player with no identifiable
   * team still gets the baseline rather than zero, since that is ignorance
   * rather than evidence of a bye.
   */
  const projectPlayer = (id) => {
    const team = nflTeams[id];
    if (team && !gameDates[team]) return 0;
    return projections[id] ?? BASELINE[positionOf(id)] ?? 7;
  };
  const teamsOf = (m) =>
    (m.starters ?? []).filter((id) => id && id !== '0').map((id) => nflTeams[id]).filter(Boolean);
  const projectTeam = (m) =>
    Math.round(
      (m.starters ?? [])
        .filter((id) => id && id !== '0')
        .reduce((sum, id) => sum + projectPlayer(id), 0) * 10,
    ) / 10;

  const teamOf = (rosterId) => {
    const r = rosterById[rosterId];
    const owner = SLEEPER_OWNERS[r?.owner_id];
    if (!owner) return null;
    const u = userById[r.owner_id];
    return { slug: owner.slug, name: owner.name, team: u?.metadata?.team_name || owner.name };
  };

  let created = 0;
  let skipped = 0;

  /**
   * Which kinds keep trading once games start.
   *
   * This was set by migrations 008 and 009 and never here, so every week built
   * after those ran came out entirely non-live -- week 2's matchups and spreads
   * would have shut at kickoff instead of repricing. The rule belongs with the
   * markets it describes.
   *
   * A blowout is the exception among spreads: it is a three-outcome field keyed
   * by roster id, and the live spread model does not describe it, so it stays
   * pregame rather than being quoted as something it is not.
   */
  const isLive = ({ kind, meta }) =>
    (kind === 'h2h' || kind === 'total' || (kind === 'spread' && !meta?.blowout));

  async function createMarket({ kind, title, subtitle, meta, options, locksAt }) {
    const [existing] = await sql`
      select id from markets
      where season = ${season} and week = ${week} and kind = ${kind} and title = ${title}`;
    if (existing) {
      skipped++;
      return;
    }
    const [m] = await sql`
      insert into markets (season, week, kind, title, subtitle, locks_at, live, meta)
      values (${season}, ${week}, ${kind}, ${title}, ${subtitle}, ${locksAt},
              ${isLive({ kind, meta })},
              ${JSON.stringify(meta)}::jsonb)
      returning id`;
    for (const o of options) {
      await sql`
        insert into market_options (market_id, option_key, label, odds)
        values (${m.id}, ${o.key}, ${o.label}, ${o.odds})`;
    }
    created++;
  }

  const byMatchup = {};
  for (const m of matchups) (byMatchup[m.matchup_id] ??= []).push(m);

  for (const pair of Object.values(byMatchup)) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    const home = teamOf(a.roster_id);
    const away = teamOf(b.roster_id);
    if (!home || !away) continue;

    const projHome = projectTeam(a);
    const projAway = projectTeam(b);
    const { home: oddsHome, away: oddsAway } = twoWayOdds(h2hProbability(projHome, projAway));
    const matchupLock = lockTimeFor([...teamsOf(a), ...teamsOf(b)], gameDates, fallbackLock);

    await createMarket({
      kind: 'h2h',
      title: `${home.team} vs ${away.team}`,
      subtitle: 'Who wins the matchup',
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        awaySlug: away.slug,
      },
      locksAt: matchupLock,
      options: [
        { key: 'home', label: home.team, odds: oddsHome },
        { key: 'away', label: away.team, odds: oddsAway },
      ],
    });

    const raw = Math.round((projHome - projAway) * 2) / 2;
    const spread = Number.isInteger(raw) ? raw + 0.5 : raw;
    const favourite = spread >= 0 ? home : away;
    const underdog = spread >= 0 ? away : home;
    const abs = Math.abs(spread);
    await createMarket({
      kind: 'spread',
      title: `${favourite.team} -${abs} vs ${underdog.team}`,
      subtitle: `Does ${favourite.team} win by more than ${abs}?`,
      meta: {
        homeRoster: a.roster_id,
        awayRoster: b.roster_id,
        homeSlug: home.slug,
        favouriteSlug: favourite.slug,
        underdogSlug: underdog.slug,
        spread: abs,
      },
      locksAt: matchupLock,
      options: [
        { key: 'cover', label: `${favourite.team} -${abs}`, odds: -110 },
        { key: 'nocover', label: `${underdog.team} +${abs}`, odds: -110 },
      ],
    });

    // Blowout markets: "does EITHER team win by more than the line", one option
    // per manager.
    //
    // Three outcomes, not two -- the third is a close game, where BOTH sides
    // lose. That is what lets both be priced at plus money: "neither" is the
    // likeliest result by far (37-56% depending on the line), and it pays out
    // nothing.
    //
    // Which is exactly why twoWayOdds is wrong here. It splits a margin across
    // two outcomes that sum to 1; these two sum to well under 1, and pricing
    // them as a pair would quote both sides far too short. fieldOdds prices a
    // field of any size, and here the field includes the outcome nobody can
    // back.
    for (const line of [20.5, 30.5]) {
      const pHome = 1 - normalCdfFor(line - (projHome - projAway));
      const pAway = normalCdfFor(-line - (projHome - projAway));
      // Nothing anyone would take, and nothing worth the row on a phone.
      if (pHome < 0.03 && pAway < 0.03) continue;

      // The unbackable outcome is a real part of the book and has to be in the
      // weights, or the two prices would be normalised against each other and
      // come out far too short.
      const neither = Math.max(0, 1 - pHome - pAway);
      const priced = fieldOdds({
        [a.roster_id]: pHome,
        [b.roster_id]: pAway,
        nobody: neither,
      });

      await createMarket({
        kind: 'spread',
        // The matchup has to be in the title: createMarket dedupes on
        // season+week+kind+title, so "Does either team win by more than 20.5?"
        // alone collapsed all five games into one market.
        title: `${home.team} vs ${away.team}: either team by ${line}+?`,
        subtitle: `Does either side win by more than ${line}? A close game loses both.`,
        meta: {
          homeRoster: a.roster_id,
          awayRoster: b.roster_id,
          homeSlug: home.slug,
          awaySlug: away.slug,
          spread: line,
          blowout: true,
          alternate: true,
        },
        locksAt: matchupLock,
        options: [
          { key: String(a.roster_id), label: `${home.team} by ${line}+`, odds: priced[a.roster_id] },
          { key: String(b.roster_id), label: `${away.team} by ${line}+`, odds: priced[b.roster_id] },
        ],
      });
    }

    // Positional showdowns: one lineup's starters at a position against the
    // other's. Uses the same normal model, but with a standard deviation scaled
    // to the position group rather than the whole lineup -- three WRs swing far
    // less than a full roster does.
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const groupOf = (matchup) =>
        (matchup.starters ?? [])
          .filter((id) => id && id !== '0')
          .filter((id) => positionOf(id) === pos);

      const homeGroup = groupOf(a);
      const awayGroup = groupOf(b);
      // A showdown needs both sides to field someone, or it can only ever void.
      if (!homeGroup.length || !awayGroup.length) continue;

      const projGroupHome = homeGroup.reduce((sum, id) => sum + projectPlayer(id), 0);
      const projGroupAway = awayGroup.reduce((sum, id) => sum + projectPlayer(id), 0);

      // Per-player SD, scaled by how many players are in the group. LEAGUE_SD
      // is for a whole nine-man lineup, so applying it to a single TE would
      // price every showdown as a coin flip.
      const players = Math.max(homeGroup.length, awayGroup.length);
      const groupSd = (LEAGUE_SD / 3) * Math.sqrt(players);

      const rawEdge = Math.round((projGroupHome - projGroupAway) * 2) / 2;
      const edge = Number.isInteger(rawEdge) ? rawEdge + 0.5 : rawEdge;
      const favIsHome = edge >= 0;
      const favTeam = favIsHome ? home : away;
      const dogTeam = favIsHome ? away : home;
      const line = Math.abs(edge);

      const pCover = h2hProbability(
        favIsHome ? projGroupHome : projGroupAway,
        (favIsHome ? projGroupAway : projGroupHome) + line,
        groupSd,
      );
      const priced = twoWayOdds(pCover);

      await createMarket({
        kind: 'showdown',
        title: `${favTeam.team} ${pos}s -${line} vs ${dogTeam.team} ${pos}s`,
        subtitle: `Do ${favTeam.team}'s starting ${pos}s outscore ${dogTeam.team}'s by more than ${line}?`,
        meta: {
          position: pos,
          homeRoster: a.roster_id,
          awayRoster: b.roster_id,
          homeSlug: home.slug,
          awaySlug: away.slug,
          favouriteSide: favIsHome ? 'home' : 'away',
          favouriteSlug: favTeam.slug,
          underdogSlug: dogTeam.slug,
          spread: line,
        },
        locksAt: matchupLock,
        options: [
          { key: 'cover', label: `${favTeam.team} ${pos}s -${line}`, odds: priced.home },
          { key: 'nocover', label: `${dogTeam.team} ${pos}s +${line}`, odds: priced.away },
        ],
      });
    }

    for (const [side, team, proj, rosterId, matchup] of [
      ['home', home, projHome, a.roster_id, a],
      ['away', away, projAway, b.roster_id, b],
    ]) {
      const line = Math.round(proj * 2) / 2 + 0.5;
      await createMarket({
        kind: 'total',
        title: `${team.team} over/under ${line}`,
        subtitle: `Does ${team.team} score more than ${line}?`,
        meta: { rosterId, slug: team.slug, line, side },
        locksAt: lockTimeFor(teamsOf(matchup), gameDates, fallbackLock),
        options: [
          { key: 'over', label: `Over ${line}`, odds: -110 },
          { key: 'under', label: `Under ${line}`, odds: -110 },
        ],
      });
    }
  }

  // A prop for every skill starter, so anyone can bet anyone on their roster.
  // Kickers and defences are skipped: their scoring is close to a coin flip, so
  // the line carries no information and nobody wants to bet it.
  const candidates = [];
  for (const m of matchups) {
    const team = teamOf(m.roster_id);
    if (!team) continue;
    const starting = new Set((m.starters ?? []).filter((x) => x && x !== '0'));
    // EVERY rostered skill player, not just the ones in the lineup. A bench
    // player is exactly as bettable as a starter -- and betting on whether
    // somebody's benched sleeper outscores their starter is the more
    // interesting question.
    for (const id of (m.players ?? []).filter((x) => x && x !== '0')) {
      const pos = positionOf(id);
      if (!['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;

      const projection = projectPlayer(id);
      // A player projected at zero is on a bye, hurt, or inactive. At the
      // usual line that becomes "over/under 0.5" at -110 each way, which is
      // not a bet -- it is free money for whoever read the injury report.
      // Skip them rather than post a trap.
      if (projection < PROP_FLOOR) continue;

      candidates.push({
        playerId: id,
        name: nameOf(id),
        position: pos,
        rosterId: m.roster_id,
        slug: team.slug,
        team: team.team,
        nflTeam: nflTeams[id],
        projection,
        benched: !starting.has(id),
      });
    }
  }
  candidates.sort((x, y) => y.projection - x.projection);

  for (const p of candidates) {
    const line = Math.round(p.projection * 2) / 2 + 0.5;
    await createMarket({
      kind: 'prop',
      title: `${p.name} over/under ${line}`,
      subtitle: `${p.position} · ${p.benched ? 'benched by' : 'started by'} ${p.team}`,
      meta: {
        playerId: p.playerId,
        playerName: p.name,
        position: p.position,
        rosterId: p.rosterId,
        slug: p.slug,
        line,
        nflTeam: p.nflTeam,
        benched: p.benched,
      },
      locksAt: lockTimeFor([p.nflTeam], gameDates, fallbackLock),
      options: [
        { key: 'over', label: `Over ${line}`, odds: -110 },
        { key: 'under', label: `Under ${line}`, odds: -110 },
      ],
    });
  }

  // League-wide "best in the league this week" markets. One market, one option
  // per manager -- unlike everything else on the board, these belong to no
  // matchup, which is why they get their own section rather than a game card.
  //
  // They are team bets: if your roster started the top RB, your option wins.
  const specials = [
    { key: 'team', title: 'Highest scoring team', subtitle: 'Most points in the league this week' },
    { key: 'RB', title: 'Highest scoring RB', subtitle: 'Best starting RB in the league' },
    { key: 'WR', title: 'Highest scoring WR', subtitle: 'Best starting WR in the league' },
    { key: 'TE', title: 'Highest scoring TE', subtitle: 'Best starting TE in the league' },
  ];

  for (const spec of specials) {
    // Weight each roster by what it is projected to bring to this question --
    // its whole lineup for the team market, its best starter at that position
    // otherwise. A roster with no starter at the position is left out entirely
    // rather than priced as a longshot it cannot win.
    const weights = {};
    const labels = {};
    for (const m of matchups) {
      const team = teamOf(m.roster_id);
      if (!team) continue;
      const starters = (m.starters ?? []).filter((x) => x && x !== '0');

      let weight;
      if (spec.key === 'team') {
        weight = projectTeam(m);
      } else {
        const atPosition = starters
          .filter((id) => positionOf(id) === spec.key)
          .map((id) => projectPlayer(id));
        if (!atPosition.length) continue;
        weight = Math.max(...atPosition);
      }
      if (!(weight > 0)) continue;
      weights[m.roster_id] = weight;
      labels[m.roster_id] = team.team;
    }

    const rosterIds = Object.keys(weights);
    // Needs a real field. Two managers is not a market worth pricing.
    if (rosterIds.length < 3) continue;

    const prices = fieldOdds(weights);
    await createMarket({
      kind: 'special',
      title: spec.title,
      subtitle: spec.subtitle,
      meta: {
        special: spec.key === 'team' ? 'team' : 'position',
        ...(spec.key === 'team' ? {} : { position: spec.key }),
      },
      // Every lineup in the league is involved, so this locks at the EARLIEST
      // kickoff of the week, not the latest. fallbackLock is the last game day
      // and would have left it bettable after the answer was half known.
      locksAt: lockTimeFor(Object.keys(gameDates), gameDates, fallbackLock),
      options: rosterIds.map((id) => ({
        key: String(id),
        label: labels[id],
        odds: prices[id],
      })),
    });
  }

  return { created, skipped };
}

/** Settles a week's markets from final scores. Already-settled markets are skipped. */
export async function settleWeek(sql, season, week) {
  const matchups = await api(`/league/${LEAGUE_ID}/matchups/${week}`);
  if (!matchups?.some((m) => m.points > 0)) {
    return { settled: 0, voided: 0, note: 'no scores' };
  }

  const pointsByRoster = {};
  const pointsByPlayer = {};
  const startedPlayers = new Set();
  // Which roster STARTED each player, and what he scored. League-wide "best RB
  // this week" markets settle off this: a player on a bench did not count for
  // his manager's score and must not win him the bet either.
  const starterRosters = {};
  for (const m of matchups) {
    pointsByRoster[m.roster_id] = Number(m.points ?? 0);
    for (const [pid, pts] of Object.entries(m.players_points ?? {})) {
      pointsByPlayer[pid] = Math.max(pointsByPlayer[pid] ?? 0, Number(pts ?? 0));
    }
    const points = m.starters_points ?? [];
    for (const [i, id] of (m.starters ?? []).entries()) {
      if (!id || id === '0') continue;
      startedPlayers.add(id);
      starterRosters[id] = { rosterId: m.roster_id, points: Number(points[i] ?? 0) };
    }
  }

  // Positions come from the slim player file the live view already uses.
  // Only special markets need them, so a missing file degrades to voiding
  // those rather than failing the whole settlement.
  let positionOf = () => '?';
  try {
    const slim = await loadPlayerIndex();
    positionOf = (id) => slim[id]?.p ?? '?';
  } catch {
    // Left as the stub; positional specials will void.
  }

  const markets = await sql`
    select id, kind, title, status, meta from markets
    where season = ${season} and week = ${week} and status not in ('settled', 'void')`;

  let settled = 0;
  let voided = 0;
  for (const m of markets) {
    const outcome = resolveMarket(m, {
      pointsByRoster,
      pointsByPlayer,
      startedPlayers,
      starterRosters,
      positionOf,
    });
    if (outcome == null) continue;
    await settleMarket(Number(m.id), outcome);
    if (outcome === 'void') voided++;
    else settled++;
  }

  return { settled, voided };
}
