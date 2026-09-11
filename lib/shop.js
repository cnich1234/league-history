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
    select id, kind, cost_points, bought_at, detail
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
export async function useBoostOnBet({ slug, boostId, betId, season = null }) {
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
           m.locks_at, m.live, m.status as market_status, m.season
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  const targetSeason = season ?? bet.season ?? null;

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

  // Mirror: the attack rebounds onto the attacker's own biggest open bet.
  //
  // Checked here rather than at settlement because the redirection has to
  // change WHERE the boost attaches, not just what it does. An attacker who
  // fires at a mirrored bet is told -- concealing it would make the boost feel
  // broken rather than clever.
  let landedOn = betId;
  let reflected = false;
  if (def.attack) {
    const mirrored = await mirroredBets([Number(betId)]);
    if (mirrored[betId]) {
      const own = await biggestOpenBet(slug, targetSeason);
      if (!own) {
        throw new Error(
          `That bet is mirrored. With no open bet of your own there is nothing for it ` +
            `to rebound onto, so ${def.name} would simply be wasted.`,
        );
      }
      landedOn = own;
      reflected = true;
    }
  }

  const [row] = await sql`
    update boosts set target_bet_id = ${landedOn}, used_at = now(),
                      detail = ${JSON.stringify(reflected ? { reflected: true, aimedAt: String(betId) } : {})}::jsonb
    where id = ${boostId} and used_at is null
    returning id, kind, target_bet_id, used_at`;
  if (!row) throw new Error('That boost has already been used.');
  return { ...row, reflected };
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
export async function consumeOddsBoost({ slug, season, odds, boostId }) {
  // Chosen explicitly at placement, never auto-applied. It used to arm and fire
  // on whatever you bet next, which left too much room to spend it by accident
  // on a bet you did not mean to boost.
  if (boostId == null) return null;

  const [owned] = await sql`
    select id, kind, owner, used_at from boosts where id = ${Number(boostId)}`;
  if (!owned) throw new Error('No such boost.');
  if (owned.owner !== slug) throw new Error('That boost is not yours.');
  if (owned.kind !== 'odds-boost') throw new Error('That boost does not change a price.');
  if (owned.used_at) throw new Error('That boost has already been used.');

  const def = byKind[owned.kind];
  // The `used_at is null` guard is what makes this safe, not the check above:
  // two placements racing for one boost can both pass the read, and only one
  // can win the update.
  const [claimed] = await sql`
    update boosts set used_at = now(), detail = ${JSON.stringify({ from: odds })}::jsonb
    where id = ${owned.id} and used_at is null
    returning id`;
  if (!claimed) throw new Error('That boost has already been used.');

  return { odds: boostOdds(odds, def.oddsMultiplier ?? 1.5), boostId: Number(claimed.id) };
}

/** Unused odds boosts, so the bet slip can offer them. */
export async function availableOddsBoosts(slug, season) {
  const rows = await sql`
    select id, kind from boosts
    where owner = ${slug} and season = ${season} and used_at is null and kind = 'odds-boost'
    order by bought_at`;
  return rows.map((r) => ({ id: String(r.id), kind: r.kind }));
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
  if (clash) {
    throw new Error(
      def.kind === 'ghost'
        ? `You are already hidden for week ${week}.`
        : `You already declared ${def.name} for week ${week}.`,
    );
  }

  const [row] = await sql`
    update boosts set used_at = now(), detail = ${JSON.stringify({ week })}::jsonb
    where id = ${boostId} and used_at is null
    returning id, kind, detail`;
  if (!row) throw new Error('That boost has already been used.');
  return row;
}

/**
 * Boosts that are armed and will fire on their own.
 *
 * Only Big Week now: it applies to the whole week with nothing to point at, so
 * without this it would be invisible. Better Price used to arm the same way and
 * fire on whatever you bet next -- it is now chosen in the bet slip instead,
 * where you can see what it does to the price before committing.
 */
export async function getArmedBoosts(slug, season, week) {
  const rows = await sql`
    select id, kind, used_at, detail from boosts
    where owner = ${slug} and season = ${season}
      and kind = 'boost-week' and used_at is not null
      and (detail->>'week')::int = ${week}`;
  return rows.map((r) => {
    const def = byKind[r.kind];
    return {
      id: String(r.id),
      kind: r.kind,
      name: def?.name ?? r.kind,
      icon: def?.icon ?? '🎰',
      note: `is live for week ${week}`,
    };
  });
}

/**
 * Copies someone else's bet, blind.
 *
 * You never learn what it is -- the new bet points at the same market and
 * option, and the UI shows it like any other bet of yours once it settles. It
 * costs you the stake out of this week, exactly as betting it yourself would.
 *
 * Deliberately NOT an attack: the person copied loses nothing, keeps their bet
 * unchanged, and both of you win or lose together. It is a bet on the person.
 */
export async function rideAlong({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'ride-along') throw new Error('That boost does not copy a bet.');

  const [source] = await sql`
    select b.id, b.bettor, b.market_id, b.option_key, b.odds, b.stake_cents, b.status,
           b.is_parlay, m.week, m.status as market_status
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!source) throw new Error('No such bet.');
  if (source.bettor === slug) throw new Error('That is already your bet.');
  if (source.status !== 'pending') throw new Error('That bet has already settled.');
  if (source.is_parlay) throw new Error('A parlay cannot be ridden along with.');
  if (source.market_status !== 'open') throw new Error('That market has closed.');

  // One copy per market, same as any other bet -- otherwise riding along twice
  // would sidestep the one-bet-per-market rule.
  const [clash] = await sql`
    select 1 from bets where bettor = ${slug} and market_id = ${source.market_id}`;
  if (clash) throw new Error('You already have a bet on that market.');

  const stake = Number(source.stake_cents);
  const [bal] = await sql`
    select coalesce(sum(amount_cents), 0)::bigint as balance
    from ledger where bettor = ${slug} and week = ${source.week}`;
  if (Number(bal?.balance ?? 0) < stake) {
    throw new Error('Not enough left this week to match that stake.');
  }

  // The copy takes the ORIGINAL price, not today's. You are buying their bet as
  // it was placed, which is the whole idea.
  const [copy] = await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds, status)
    values (${slug}, ${source.market_id}, ${source.option_key}, ${stake}, ${source.odds}, 'pending')
    returning id, stake_cents, odds`;

  await sql`
    insert into ledger (bettor, amount_cents, reason, bet_id, note, week)
    values (${slug}, ${-stake}, 'stake', ${copy.id}, 'Rode along', ${source.week})`;

  await sql`
    update boosts set target_bet_id = ${betId}, used_at = now(),
                      detail = ${JSON.stringify({ copiedBet: String(copy.id) })}::jsonb
    where id = ${boostId} and used_at is null`;

  return { id: String(copy.id), stakeCents: stake, odds: copy.odds };
}

/**
 * Curses a manager's whole week: everything they win pays 30% less.
 *
 * Stored against (target, week) rather than a bet, so settlement has to look it
 * up per bettor -- the same shape as Big Week, and read in the same place.
 */
export async function curseWeek({ slug, boostId, target, week }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'week-curse') throw new Error('That boost is not a curse.');
  if (target === slug) throw new Error('Point that at someone else.');

  const [victim] = await sql`select slug from bettors where slug = ${target}`;
  if (!victim) throw new Error('No such manager.');

  const [clash] = await sql`
    select 1 from boosts
    where kind = 'week-curse' and target_bettor = ${target}
      and (detail->>'week')::int = ${week} and used_at is not null`;
  if (clash) throw new Error('Somebody has already cursed them this week.');

  const [row] = await sql`
    update boosts set target_bettor = ${target}, used_at = now(),
                      detail = ${JSON.stringify({ week })}::jsonb
    where id = ${boostId} and used_at is null
    returning id, kind, detail`;
  if (!row) throw new Error('That boost has already been used.');
  return row;
}

/**
 * Voids one of your own bets and returns the stake.
 *
 * Any bet that has not settled, live ones included -- the pitch is watching a
 * bet die and pulling out. That is why it is the dearest thing in the shop: it
 * removes risk entirely, where Cash Out only lets you settle early at whatever
 * the position is currently worth.
 *
 * The refund goes back to the week the stake CAME FROM, which is the honest
 * place for it even though a spent week cannot be re-bet. Undoing during the
 * week it was placed -- the common case -- returns money you can use again.
 */
export async function undoBet({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'undo') throw new Error('That boost does not void a bet.');

  const [bet] = await sql`
    select b.id, b.bettor, b.status, b.stake_cents, b.is_parlay
    from bets b where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  if (bet.bettor !== slug) throw new Error('Undo only works on your own bet.');
  if (bet.status !== 'pending') throw new Error('That bet has already settled.');

  // What the bet actually COST, read from the ledger rather than from
  // stake_cents. A Slow Play makes a bet cost double to place, so refunding the
  // nominal stake would hand back less than was taken -- and undoing a slowed
  // bet would quietly cost you money on top of the boost.
  const [stakeRow] = await sql`
    select week, amount_cents from ledger
    where bet_id = ${betId} and reason = 'stake' limit 1`;
  const stake = stakeRow ? Math.abs(Number(stakeRow.amount_cents)) : Number(bet.stake_cents);

  const [voided] = await sql`
    update bets set status = 'void', payout_cents = ${stake}, settled_at = now()
    where id = ${betId} and status = 'pending'
    returning id`;
  // Lost a race with settlement: the bet resolved while this was in flight.
  if (!voided) throw new Error('That bet settled before the undo landed.');

  await sql`
    insert into ledger (bettor, amount_cents, reason, bet_id, note, week)
    values (${slug}, ${stake}, 'refund', ${betId}, 'Undone', ${stakeRow?.week ?? null})`;

  // A parlay's legs die with it.
  if (bet.is_parlay) {
    await sql`
      update parlay_legs set status = 'void', settled_at = now()
      where bet_id = ${betId} and status = 'pending'`;
  }

  await sql`
    update boosts set target_bet_id = ${betId}, used_at = now()
    where id = ${boostId} and used_at is null`;

  return { betId: String(betId), refundedCents: stake };
}

/**
 * Who attacked a bet of yours. Costs a Receipt to find out.
 *
 * Attacks are anonymous by default, which is safe but unsatisfying: someone
 * cuts your payout and you never learn who. This changes no money at all -- it
 * turns a hit into a grudge, which is the entire point.
 */
export async function readReceipt({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That receipt has already been used.');
  if (boost.kind !== 'receipt') throw new Error('That boost does not reveal anything.');

  const [bet] = await sql`select id, bettor from bets where id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  if (bet.bettor !== slug) throw new Error('You can only read your own bets.');

  const attackers = await sql`
    select b.kind, t.display_name as who, b.used_at
    from boosts b
    join bettors t on t.slug = b.owner
    where b.target_bet_id = ${betId} and b.owner <> ${slug}
    order by b.used_at`;

  // Spent either way. Finding out that nobody touched it is information too,
  // and refunding on an empty result would make it a free scan.
  await sql`
    update boosts set target_bet_id = ${betId}, used_at = now(),
                      detail = ${JSON.stringify({ found: attackers.length })}::jsonb
    where id = ${boostId} and used_at is null`;

  return attackers.map((a) => ({
    kind: a.kind,
    name: byKind[a.kind]?.name ?? a.kind,
    icon: byKind[a.kind]?.icon ?? '🎯',
    who: a.who,
  }));
}

/**
 * Mirrored bets among a set, as { betId: true }.
 *
 * A mirror is checked before an attack lands, so the attack can be redirected
 * rather than blocked. Insurance and Mirror are deliberately different: one
 * absorbs, the other returns.
 */
export async function mirroredBets(betIds) {
  if (!betIds?.length) return {};
  const rows = await sql`
    select target_bet_id from boosts
    where target_bet_id = any(${betIds.map(Number)}) and kind = 'mirror'`;
  return Object.fromEntries(rows.map((r) => [r.target_bet_id, true]));
}

/**
 * The bet an attack rebounds onto: the attacker's biggest open one.
 *
 * Biggest by stake, because that is the one they would least like hit and it
 * needs no judgement call. Returns null when they have nothing open -- a mirror
 * against someone with no bets simply blocks, since there is nothing to return
 * the attack to.
 */
export async function biggestOpenBet(slug, season) {
  const [row] = await sql`
    select b.id
    from bets b
    left join markets m on m.id = b.market_id
    where b.bettor = ${slug} and b.status = 'pending'
      and (b.market_id is null or m.season = ${season})
    order by b.stake_cents desc, b.placed_at desc
    limit 1`;
  return row ? Number(row.id) : null;
}

/**
 * Freezes a live price for one person for half an hour.
 *
 * Stored on the boost itself rather than in live_quotes, which has no owner and
 * no expiry -- a lock is personal and temporary, and that table is neither.
 *
 * Everyone else keeps betting the live market. This only changes what YOU are
 * quoted, and only until the clock runs out.
 */
export async function lockInPrice({ slug, boostId, marketId, optionKey, odds }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'lock-in') throw new Error('That boost does not lock a price.');

  const def = byKind[boost.kind];
  const [market] = await sql`
    select id, status, live from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status !== 'open') throw new Error('That market is closed.');
  if (!market.live) {
    throw new Error('Only a live price moves. A pregame line is not going anywhere.');
  }

  const expires = new Date(Date.now() + (def.lockMinutes ?? 30) * 60 * 1000);
  const [row] = await sql`
    update boosts
    set target_market_id = ${marketId}, used_at = now(),
        detail = ${JSON.stringify({ optionKey, odds, expiresAt: expires.toISOString() })}::jsonb
    where id = ${boostId} and used_at is null
    returning id, detail`;
  if (!row) throw new Error('That boost has already been used.');
  return { marketId: String(marketId), optionKey, odds, expiresAt: expires.toISOString() };
}

/**
 * A price this person has locked on a market, if it has not expired.
 *
 * Read at placement, before the live model runs -- the whole point is that the
 * number stops moving, so recomputing it would defeat the boost.
 */
export async function lockedPrice({ slug, marketId, optionKey }) {
  const [row] = await sql`
    select id, detail from boosts
    where owner = ${slug} and kind = 'lock-in' and target_market_id = ${marketId}
      and used_at is not null
      and (detail->>'optionKey') = ${optionKey}
      and (detail->>'expiresAt')::timestamptz > now()
      and detail->>'claimed' is null
    limit 1`;
  if (!row) return null;
  return { boostId: Number(row.id), odds: Number(row.detail.odds) };
}

/** Marks a locked price as spent, so it cannot be used on a second bet. */
export async function claimLockedPrice(boostId, betId) {
  await sql`
    update boosts
    set detail = detail || ${JSON.stringify({ claimed: true, betId: String(betId) })}::jsonb
    where id = ${boostId}`;
}

/**
 * Opens a hedge: lets one more bet onto a market you are already on.
 *
 * The one-bet-per-market rule exists so nobody can back both sides and collect
 * either way at the same price. A hedge is the deliberate exception -- you take
 * the other side at the CURRENT price, which on a live market is a different
 * number from the one you got, so squaring off costs something.
 */
export async function openHedge({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'hedge') throw new Error('That boost does not open a hedge.');

  const [bet] = await sql`
    select b.id, b.bettor, b.status, b.market_id, b.option_key, m.status as market_status
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  if (bet.bettor !== slug) throw new Error('Hedge only works on your own bet.');
  if (bet.status !== 'pending') throw new Error('That bet has already settled.');
  if (bet.is_parlay || bet.market_id == null) {
    throw new Error('A parlay cannot be hedged -- it spans several markets.');
  }
  if (bet.market_status !== 'open') throw new Error('That market has closed.');

  const [row] = await sql`
    update boosts set target_bet_id = ${betId}, used_at = now(),
                      detail = ${JSON.stringify({ marketId: String(bet.market_id) })}::jsonb
    where id = ${boostId} and used_at is null
    returning id`;
  if (!row) throw new Error('That boost has already been used.');
  return { marketId: String(bet.market_id), alreadyOn: bet.option_key };
}

/** Markets where this person has an open hedge, so placement lets a second bet through. */
export async function hedgedMarkets(slug) {
  const rows = await sql`
    select (detail->>'marketId')::bigint as market_id
    from boosts
    where owner = ${slug} and kind = 'hedge' and used_at is not null
      and detail->>'spent' is null`;
  return new Set(rows.map((r) => String(r.market_id)));
}

/** Consumes a hedge once the second bet is placed. */
export async function spendHedge(slug, marketId) {
  await sql`
    update boosts set detail = detail || '{"spent": true}'::jsonb
    where id = (
      select id from boosts
      where owner = ${slug} and kind = 'hedge' and used_at is not null
        and (detail->>'marketId')::bigint = ${marketId}
        and detail->>'spent' is null
      limit 1
    )`;
}

/**
 * Moves someone's bet to a different option on the same market.
 *
 * Two-sided markets flip to the other side. A ten-way special lands on a random
 * one of the nine others, which is a far heavier blow -- and neither the
 * attacker nor the victim gets to choose, because the attacker cannot see the
 * bet at all.
 *
 * The ODDS move with it. Their stake now rides whatever the new option was
 * priced at when the bet was placed, not what they originally took, so a flip
 * changes what the bet is worth as well as what it needs to happen.
 */
export async function switcheroo({ slug, boostId, betId }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'switcheroo') throw new Error('That boost does not move a bet.');

  const [bet] = await sql`
    select b.id, b.bettor, b.status, b.market_id, b.option_key, b.is_parlay,
           m.status as market_status, m.season
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  if (bet.bettor === slug) throw new Error('Switcheroo is for someone else.');
  if (bet.status !== 'pending') throw new Error('That bet has already settled.');
  if (bet.is_parlay || bet.market_id == null) {
    throw new Error('A parlay cannot be switched -- it spans several markets.');
  }

  // Insurance blocks it like any other attack, and a mirror sends it back.
  const [shield] = await sql`
    select 1 from boosts where target_bet_id = ${betId} and kind = 'insurance'`;
  if (shield) throw new Error('That bet is insured.');

  const mirrored = await mirroredBets([Number(betId)]);
  let victimBetId = Number(betId);
  let reflected = false;
  if (mirrored[betId]) {
    const own = await biggestOpenBet(slug, bet.season);
    if (!own) {
      throw new Error(
        'That bet is mirrored. With no open bet of your own there is nothing for it to ' +
          'rebound onto, so Switcheroo would simply be wasted.',
      );
    }
    victimBetId = own;
    reflected = true;
  }

  const [current] = await sql`
    select market_id, option_key from bets where id = ${victimBetId}`;
  const others = await sql`
    select option_key, odds from market_options
    where market_id = ${current.market_id} and option_key <> ${current.option_key}`;
  if (!others.length) throw new Error('That market has nowhere else to go.');

  // Random on a multi-way market; on a two-sided one there is only ever one
  // other option, so this is simply the flip.
  const pick = others[Math.floor(Math.random() * others.length)];

  const [moved] = await sql`
    update bets set option_key = ${pick.option_key}, odds = ${pick.odds}
    where id = ${victimBetId} and status = 'pending'
    returning id, option_key, odds`;
  if (!moved) throw new Error('That bet settled before the switch landed.');

  await sql`
    update boosts set target_bet_id = ${victimBetId}, used_at = now(),
                      detail = ${JSON.stringify({
                        from: current.option_key,
                        to: pick.option_key,
                        choices: others.length,
                        ...(reflected ? { reflected: true, aimedAt: String(betId) } : {}),
                      })}::jsonb
    where id = ${boostId} and used_at is null`;

  return {
    betId: String(victimBetId),
    to: pick.option_key,
    outOf: others.length,
    reflected,
  };
}

/**
 * Doubles what a manager's next bet costs them.
 *
 * The only attack that hits the ALLOWANCE rather than the payout: a $500 week
 * buys half as much until they have worn it off. It costs them nothing if they
 * simply stop betting, which is why it is cheap.
 */
export async function slowPlay({ slug, boostId, target, week }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'slow-play') throw new Error('That boost does not slow anyone down.');
  if (target === slug) throw new Error('Point that at someone else.');

  const [victim] = await sql`select slug from bettors where slug = ${target}`;
  if (!victim) throw new Error('No such manager.');

  const [clash] = await sql`
    select 1 from boosts
    where kind = 'slow-play' and target_bettor = ${target} and used_at is not null
      and (detail->>'week')::int = ${week} and detail->>'spent' is null`;
  if (clash) throw new Error('They are already slowed this week.');

  const [row] = await sql`
    update boosts set target_bettor = ${target}, used_at = now(),
                      detail = ${JSON.stringify({ week })}::jsonb
    where id = ${boostId} and used_at is null
    returning id`;
  if (!row) throw new Error('That boost has already been used.');
  return { target, week };
}

/** An unspent Slow Play against this manager, if any. */
export async function pendingSlowPlay(slug, week) {
  const [row] = await sql`
    select id from boosts
    where kind = 'slow-play' and target_bettor = ${slug} and used_at is not null
      and (detail->>'week')::int = ${week} and detail->>'spent' is null
    limit 1`;
  return row ? Number(row.id) : null;
}

/** Burns a Slow Play once the doubled bet is placed. */
export async function spendSlowPlay(boostId, betId) {
  await sql`
    update boosts set detail = detail || ${JSON.stringify({ spent: true, betId: String(betId) })}::jsonb
    where id = ${boostId}`;
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

  // Week-wide boosts, joined by (owner, week) because they attach to no bet.
  // Two different relationships share this shape: Big Week belongs to the
  // person who BOUGHT it, a curse belongs to the person it was aimed AT.
  const weekWide = await sql`
    select b.id as bet_id, bo.kind
    from bets b
    join markets m on m.id = b.market_id
    join boosts bo
      on bo.season = m.season
     and (bo.detail->>'week')::int = m.week
     and bo.used_at is not null
     and (
       (bo.owner = b.bettor and bo.kind = 'boost-week')
       or (bo.target_bettor = b.bettor and bo.kind = 'week-curse')
     )
    where b.id = any(${ids})`;

  const byBet = {};
  for (const r of attached) (byBet[r.target_bet_id] ??= []).push(r.kind);
  for (const r of weekWide) {
    const list = (byBet[r.bet_id] ??= []);
    if (!list.includes(r.kind)) list.push(r.kind);
  }
  return byBet;
}

/**
 * Who stole each of these bets, as { betId: thiefSlug }.
 *
 * Insurance blocks a theft exactly as it blocks any other attack, so a shielded
 * bet is absent from the result even if a Grand Theft is attached to it. That
 * check lives here rather than at settlement so there is one place to get it
 * wrong.
 */
export async function thievesFor(betIds) {
  if (!betIds?.length) return {};
  const ids = betIds.map(Number);
  const rows = await sql`
    select b.target_bet_id, b.owner
    from boosts b
    where b.target_bet_id = any(${ids}) and b.kind = 'steal'
      and not exists (
        select 1 from boosts s
        where s.target_bet_id = b.target_bet_id and s.kind = 'insurance'
      )`;
  return Object.fromEntries(rows.map((r) => [r.target_bet_id, r.owner]));
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
