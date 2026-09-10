import { neon } from '@neondatabase/serverless';
import {
  BOOSTS,
  byKind,
  WEEKLY_ALLOWANCE,
  canAttach,
  boostOdds,
  FAMILY,
  TARGET,
} from './boosts.js';

/**
 * The shop: points in, boosts out.
 *
 * Points follow the money's discipline exactly -- an append-only ledger, with
 * the balance as a derived view rather than a stored number. A stored balance
 * drifts and nothing notices; a sum cannot.
 *
 * Every rule that could be broken is checked here against the database, not in
 * the browser, for the same reason placeBet does it: a check in a component is
 * a suggestion.
 */

let _sql = null;
const sql = (...args) => {
  if (!_sql) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql(...args);
};

/* ---------- points ---------- */

/**
 * Someone's spendable points for a season.
 *
 * Scoped to the season on purpose. The point_balances view sums a manager's
 * whole history, which is the right number for a career total and the wrong one
 * for a wallet -- without the filter, next season would open with this season's
 * leftovers already banked.
 */
export async function getPoints(slug, season) {
  const [row] = await sql`
    select coalesce(sum(amount), 0)::int as points
    from point_ledger where bettor = ${slug} and season = ${season}`;
  return Number(row?.points ?? 0);
}

/** Every manager's spendable points for a season, richest first. */
export async function getPointBalances(season) {
  return sql`
    select b.slug, b.display_name,
           coalesce(sum(p.amount) filter (where p.season = ${season}), 0)::int as points
    from bettors b
    left join point_ledger p on p.bettor = b.slug
    group by b.slug, b.display_name
    order by points desc, b.display_name`;
}

/** Where someone's points came from and went, newest first. */
export async function getPointHistory(slug, limit = 50) {
  return sql`
    select id, season, week, amount, reason, note, created_at
    from point_ledger where bettor = ${slug}
    order by created_at desc, id desc limit ${limit}`;
}

/**
 * Credits the weekly allowance to everyone. Safe to run repeatedly.
 *
 * The unique index does the work: a second run for the same week conflicts and
 * is ignored, so a cron that fires twice cannot double-pay.
 */
export async function grantWeeklyAllowance(season, week) {
  const rows = await sql`
    insert into point_ledger (bettor, season, week, amount, reason, note)
    select slug, ${season}, ${week}, ${WEEKLY_ALLOWANCE}, 'allowance', ${'Week ' + week}
    from bettors
    on conflict do nothing
    returning bettor`;
  return rows.map((r) => r.bettor);
}

/**
 * Credits a week's trophy points, from the weekly scoring.
 *
 * `bySlug` is { slug: points }. Also once-only per week, so re-running the
 * scoring cannot inflate anyone.
 */
export async function grantTrophyPoints(season, week, bySlug) {
  const entries = Object.entries(bySlug ?? {}).filter(([, n]) => Number.isFinite(n) && n !== 0);
  if (!entries.length) return [];

  const granted = [];
  for (const [slug, amount] of entries) {
    const rows = await sql`
      insert into point_ledger (bettor, season, week, amount, reason, note)
      values (${slug}, ${season}, ${week}, ${Math.round(amount)}, 'trophies', ${'Week ' + week + ' trophies'})
      on conflict do nothing
      returning bettor`;
    if (rows.length) granted.push(slug);
  }
  return granted;
}

/* ---------- buying ---------- */

/** What someone owns and has not used yet. */
export async function getInventory(slug, season) {
  return sql`
    select id, kind, cost_points, bought_at
    from boosts
    where owner = ${slug} and season = ${season} and used_at is null
    order by bought_at`;
}

/** Everything someone has ever bought, used or not. */
export async function getBoostHistory(slug, season) {
  return sql`
    select b.id, b.kind, b.cost_points, b.bought_at, b.used_at, b.detail,
           b.target_bet_id, b.target_market_id, b.target_bettor,
           m.title as market_title,
           t.display_name as target_name
    from boosts b
    left join markets m on m.id = b.target_market_id
    left join bettors t on t.slug = b.target_bettor
    where b.owner = ${slug} and b.season = ${season}
    order by b.bought_at desc`;
}

/**
 * Buys a boost. Points are debited immediately; the boost sits unused until
 * it is applied to something.
 *
 * The balance is re-read inside this call rather than trusted from the client,
 * and a negative result is refused -- the same reason placeBet re-checks a
 * bankroll it was just shown.
 */
export async function buyBoost({ slug, season, kind }) {
  const def = byKind[kind];
  if (!def) throw new Error('No such boost.');
  // Refused here, not merely greyed in the shop -- a listed price is an
  // invitation, and these have no working target picker behind them yet.
  if (def.comingSoon) throw new Error(`${def.name} is not available yet.`);

  const points = await getPoints(slug, season);
  if (points < def.cost) {
    throw new Error(`Not enough points. ${def.name} costs ${def.cost}, you have ${points}.`);
  }

  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${slug}, ${season}, ${-def.cost}, 'purchase', ${def.name})`;

  const [row] = await sql`
    insert into boosts (owner, season, kind, cost_points)
    values (${slug}, ${season}, ${kind}, ${def.cost})
    returning id, kind, cost_points, bought_at`;

  return row;
}

/* ---------- using ---------- */

/**
 * Attaches an owned boost to a bet.
 *
 * Everything is verified server-side: that the boost is yours, unused, and
 * allowed on that bet in its current state. An attack on your own bet is
 * refused, and so is defence of someone else's -- both are almost certainly a
 * mistake rather than a strategy.
 */
export async function useBoostOnBet({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');

  const def = byKind[boost.kind];
  if (!def) throw new Error('No such boost.');
  if (def.target !== TARGET.BET && def.target !== TARGET.OWN_BET) {
    throw new Error(`${def.name} is not used on a bet.`);
  }

  const [bet] = await sql`
    select b.id, b.bettor, b.status, b.market_id,
           m.locks_at, m.live, m.status as market_status
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');

  const mine = bet.bettor === slug;
  if (def.target === TARGET.OWN_BET && !mine) {
    throw new Error(`${def.name} can only go on your own bet.`);
  }
  if (def.attack && mine) {
    throw new Error(`${def.name} is for someone else's bet.`);
  }

  const check = canAttach(def, {
    marketLocked: bet.locks_at ? new Date(bet.locks_at) <= new Date() : false,
    marketLive: Boolean(bet.live),
    betStatus: bet.status,
  });
  if (!check.ok) throw new Error(check.why);

  // One of each kind per bet, or the maths stops being explainable. The unique
  // index enforces it; this turns the constraint error into a sentence.
  const [clash] = await sql`
    select id from boosts where target_bet_id = ${betId} and kind = ${boost.kind}`;
  if (clash) throw new Error(`That bet already has ${def.name} on it.`);

  const [row] = await sql`
    update boosts set target_bet_id = ${betId}, used_at = now()
    where id = ${boostId} and used_at is null
    returning id, kind, target_bet_id, used_at`;
  if (!row) throw new Error('That boost has already been used.');
  return row;
}

/** Attaches a market-wide boost, which affects everyone including the buyer. */
export async function useBoostOnMarket({ slug, boostId, marketId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');

  const def = byKind[boost.kind];
  if (!def || def.target !== TARGET.MARKET) throw new Error('That boost is not used on a market.');

  const [market] = await sql`
    select id, status, locks_at, live from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status !== 'open') throw new Error('That market is closed.');

  const check = canAttach(def, {
    marketLocked: new Date(market.locks_at) <= new Date() && !market.live,
    marketLive: Boolean(market.live),
  });
  if (!check.ok) throw new Error(check.why);

  const [clash] = await sql`
    select id from boosts where target_market_id = ${marketId} and kind = ${boost.kind}`;
  if (clash) throw new Error('That market has already been poisoned.');

  const [row] = await sql`
    update boosts set target_market_id = ${marketId}, used_at = now()
    where id = ${boostId} and used_at is null
    returning id, kind, target_market_id, used_at`;
  if (!row) throw new Error('That boost has already been used.');
  return row;
}

/**
 * Consumes an armed odds boost, if the buyer has one.
 *
 * Called at placement. Returns the improved odds and marks the boost used in
 * one step, so two bets placed at once cannot both claim the same boost --
 * the `used_at is null` guard on the update is what makes that safe rather
 * than the check that precedes it.
 *
 * Returns { odds, boostId } or null when there is nothing armed.
 */
export async function consumeOddsBoost({ slug, season, odds }) {
  const [armed] = await sql`
    select id, kind from boosts
    where owner = ${slug} and season = ${season} and used_at is null
      and kind = 'odds-boost'
    order by bought_at limit 1`;
  if (!armed) return null;

  const def = byKind[armed.kind];
  const [claimed] = await sql`
    update boosts set used_at = now(), detail = ${JSON.stringify({ from: odds })}::jsonb
    where id = ${armed.id} and used_at is null
    returning id`;
  // Lost the race to another placement: this bet simply does not get it.
  if (!claimed) return null;

  return { odds: boostOdds(odds, def.oddsMultiplier ?? 1.5), boostId: Number(claimed.id) };
}

/** Whether this manager has an odds boost armed, for the bet slip to show. */
export async function hasArmedOddsBoost(slug, season) {
  const [row] = await sql`
    select count(*)::int as n from boosts
    where owner = ${slug} and season = ${season} and used_at is null and kind = 'odds-boost'`;
  return Number(row?.n ?? 0) > 0;
}

/**
 * Declares a week-wide payout boost. Applies to every bet won that week.
 *
 * Stored against the week rather than a bet, so settlement has to look it up
 * per bettor rather than reading the bet's own attachments -- which is why
 * boostsForBets takes the week into account below.
 */
export async function useBoostOnWeek({ slug, boostId, week }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');

  const def = byKind[boost.kind];
  if (!def || def.target !== TARGET.WEEK) throw new Error('That boost is not used on a week.');

  const [clash] = await sql`
    select id from boosts
    where owner = ${slug} and kind = ${boost.kind} and used_at is not null
      and (detail->>'week')::int = ${week}`;
  if (clash) throw new Error(`You already declared ${def.name} for week ${week}.`);

  const [row] = await sql`
    update boosts set used_at = now(), detail = ${JSON.stringify({ week })}::jsonb
    where id = ${boostId} and used_at is null
    returning id, kind, detail`;
  if (!row) throw new Error('That boost has already been used.');
  return row;
}

/* ---------- reading boosts back ---------- */

/**
 * Boost kinds affecting each of a set of bets: { betId: ['insurance', ...] }.
 *
 * Two sources, and missing the second would make Big Week silently do nothing:
 *
 *   - boosts attached to the bet itself
 *   - week-wide boosts the bettor declared for that bet's week
 *
 * The week-wide ones are not attached to any bet, so they have to be joined in
 * by (owner, week) rather than read off the bet.
 */
export async function boostsForBets(betIds) {
  if (!betIds?.length) return {};
  const ids = betIds.map(Number);

  const attached = await sql`
    select target_bet_id, kind from boosts where target_bet_id = any(${ids})`;

  const weekWide = await sql`
    select b.id as bet_id, bo.kind
    from bets b
    join markets m on m.id = b.market_id
    join boosts bo
      on bo.owner = b.bettor
     and bo.season = m.season
     and (bo.detail->>'week')::int = m.week
     and bo.used_at is not null
    where b.id = any(${ids})`;

  const byBet = {};
  for (const r of attached) (byBet[r.target_bet_id] ??= []).push(r.kind);
  for (const r of weekWide) {
    const list = (byBet[r.bet_id] ??= []);
    if (!list.includes(r.kind)) list.push(r.kind);
  }
  return byBet;
}

/** Extra margin on a market from poisoning, as a fraction. */
export async function marketPenalty(marketId) {
  const rows = await sql`
    select kind from boosts where target_market_id = ${marketId}`;
  let bump = 0;
  for (const r of rows) bump += byKind[r.kind]?.marginBump ?? 0;
  return bump;
}

/** Poisoned markets for a week, so the board can label them. */
export async function poisonedMarkets(season, week) {
  const rows = await sql`
    select b.target_market_id, b.kind, t.display_name as by_name
    from boosts b
    join markets m on m.id = b.target_market_id
    join bettors t on t.slug = b.owner
    where m.season = ${season} and m.week = ${week}`;
  const byMarket = {};
  for (const r of rows) {
    (byMarket[r.target_market_id] ??= []).push({ kind: r.kind, by: r.by_name });
  }
  return byMarket;
}

export { BOOSTS, byKind, WEEKLY_ALLOWANCE };
