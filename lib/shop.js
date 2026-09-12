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

/**
 * Every attack kind, read from the catalogue.
 *
 * Used for the one-attack-per-bet rule. Derived rather than typed so adding an
 * attack to lib/boosts.js is enough -- the matching partial index in
 * db/018_one_attack_per_bet.sql is the one place that still needs editing by
 * hand, since SQL cannot read the catalogue.
 */
const ATTACK_KINDS = BOOSTS.filter((b) => b.attack).map((b) => b.kind);

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

  // One ATTACK per bet -- not one of each kind, which let three people pile
  // onto the same bet with a Skim, a Void and a theft, and made the payout
  // maths compose attacks that were never meant to stack. Defences and self
  // boosts keep the old rule: one of each kind.
  if (def.attack) {
    const [hit] = await sql`
      select b.kind, t.display_name as who
      from boosts b left join bettors t on t.slug = b.owner
      where b.target_bet_id = ${betId} and b.kind = any(${ATTACK_KINDS})`;
    if (hit) {
      throw new Error(
        `That bet has already been hit with ${byKind[hit.kind]?.name ?? hit.kind}. ` +
          `One attack per bet.`,
      );
    }
  } else {
    const [clash] = await sql`
      select id from boosts where target_bet_id = ${betId} and kind = ${boost.kind}`;
    if (clash) throw new Error(`That bet already has ${def.name} on it.`);

    // A shield goes on BEFORE the hit or not at all. Nothing stopped Insurance
    // being attached after a Grand Theft had landed, and settlement then treated
    // the bet as shielded -- so every attack in the shop could be undone for 36
    // points by anyone who noticed the pill on The Action. The blurb always said
    // it could not be added after the fact; now that is true.
    if (def.defensive) {
      const [hit] = await sql`
        select kind from boosts
        where target_bet_id = ${betId} and kind = any(${ATTACK_KINDS})`;
      if (hit) {
        throw new Error(
          `Too late -- that bet has already been hit with ` +
            `${byKind[hit.kind]?.name ?? hit.kind}. ${def.name} has to go on first.`,
        );
      }
    }
  }

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

  // An attack somebody paid for out of their own pocket beats a bounty that
  // was still being crowd-funded. The bet has been hit, so the bounty can
  // never land -- everyone who chipped in gets their points back.
  let killed = 0;
  if (def.attack && !reflected) killed = await cancelBountiesOnBet(landedOn);

  return { ...row, reflected, bounties: [], bountiesRefunded: killed };
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

/**
 * Unused boosts that can be applied at the moment a bet is placed.
 *
 * Better Price changes the odds, Insurance shields it and Half Again multiplies
 * the win -- all decided before the bet exists, so all offerable in the slip.
 * Attaching one afterwards means finding the bet again in My Boosts, which is
 * the step people forget.
 *
 * One of each kind: the slip offers a tick-box per kind, not per copy.
 */
export async function slipBoosts(slug, season) {
  const rows = await sql`
    select distinct on (kind) id, kind from boosts
    where owner = ${slug} and season = ${season} and used_at is null
      and kind in ('odds-boost', 'insurance', 'boost-50', 'lock-in')
    order by kind, bought_at`;
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    name: byKind[r.kind]?.name ?? r.kind,
    icon: byKind[r.kind]?.icon ?? '',
    blurb: byKind[r.kind]?.blurb ?? '',
  }));
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
 * What a live market is quoting right now for one side, from the model.
 *
 * The one place the shop asks the live model a question. Injected into the
 * boosts that need it so they can be tested without Sleeper: pass `priceNow`
 * and it is used instead.
 */
async function quoteNow(market, optionKey) {
  const { liveMatchups, livePrice, stateForMarket } = await import('./live.js');
  const state = await liveMatchups(market.season, market.week);
  const priced = livePrice(market, stateForMarket(market, state.matchups));
  if (!priced) return null;
  const odds = priced[optionKey];
  return odds == null ? null : { odds, probability: priced.probability };
}

/**
 * Settles one of your own live bets early, at what it is worth right now.
 *
 * Value = the payout it would return if it won, weighted by the live model's
 * probability that it does -- with the in-play margin already in that price,
 * which is the book's cut for letting you leave. A bet going well cashes for
 * more than its stake; a bet dying cashes for less, and that is the point:
 * take the money and stop watching.
 *
 * The bet gets its own status. The stake portion returns to the week it came
 * from, since mid-week it is re-bettable; anything above the stake banks,
 * exactly as a win's profit does.
 *
 * Existed only as a catalogue entry: useBoostOnBet attached it to the bet,
 * marked it used, and settled nothing. 18 points for a row in a table.
 */
export async function cashOut({ slug, boostId, betId, priceNow = quoteNow }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'cash-out') throw new Error('That boost does not cash anything out.');

  const [bet] = await sql`
    select b.id, b.bettor, b.status, b.stake_cents, b.odds, b.option_key, b.is_parlay,
           m.id as market_id, m.season, m.week, m.kind, m.meta, m.live, m.locks_at,
           m.status as market_status
    from bets b left join markets m on m.id = b.market_id
    where b.id = ${betId}`;
  if (!bet) throw new Error('No such bet.');
  if (bet.bettor !== slug) throw new Error('Cash Out only works on your own bet.');
  if (bet.status !== 'pending') throw new Error('That bet has already settled.');
  if (bet.is_parlay) throw new Error('A parlay cannot be cashed out -- it has no single price.');
  if (bet.market_status !== 'open') throw new Error('That market has closed.');
  if (!bet.live) throw new Error('Only a live bet can be cashed out.');
  if (new Date(bet.locks_at) > new Date()) {
    throw new Error('Nothing to cash out until the games start.');
  }

  const quote = await priceNow(
    { id: bet.market_id, season: bet.season, week: bet.week, kind: bet.kind, meta: bet.meta },
    bet.option_key,
  );
  if (!quote) throw new Error('No live price -- the result is no longer in doubt.');

  // Odds carry the margin, so the implied probability is already shaded
  // against the bettor. That shading IS the fee.
  const { impliedProbability, payoutCents } = await import('./odds.js');
  const stake = Number(bet.stake_cents);
  const value = Math.round(payoutCents(stake, bet.odds) * impliedProbability(quote.odds));

  const [done] = await sql`
    update bets set status = 'cashed', payout_cents = ${value}, settled_at = now()
    where id = ${betId} and status = 'pending'
    returning id`;
  if (!done) throw new Error('That bet settled before the cash out landed.');

  // Where the stake came from -- and what it actually cost, so a slowed bet
  // is made whole on the same basis Undo uses.
  const [stakeRow] = await sql`
    select week, amount_cents from ledger where bet_id = ${betId} and reason = 'stake' limit 1`;
  const paid = stakeRow ? Math.abs(Number(stakeRow.amount_cents)) : stake;
  const toWeek = Math.min(value, paid);
  const toBank = value - toWeek;
  if (toWeek > 0) {
    await sql`
      insert into ledger (bettor, amount_cents, reason, bet_id, note, week)
      values (${slug}, ${toWeek}, 'refund', ${betId}, 'Cashed out', ${stakeRow?.week ?? null})`;
  }
  if (toBank > 0) {
    await sql`
      insert into ledger (bettor, amount_cents, reason, bet_id, note, week)
      values (${slug}, ${toBank}, 'payout', ${betId}, 'Cashed out', null)`;
  }

  await sql`
    update boosts set target_bet_id = ${betId}, used_at = now(),
                      detail = ${JSON.stringify({ valueCents: value, at: quote.odds, from: bet.odds })}::jsonb
    where id = ${boostId} and used_at is null`;

  // A bounty raising for this bet can never land now.
  await cancelBountiesOnBet(Number(betId));

  return { betId: String(betId), valueCents: value, at: quote.odds };
}

/**
 * Freezes a live price for one person for half an hour.
 *
 * Stored on the boost itself rather than in live_quotes, which has no owner and
 * no expiry -- a lock is personal and temporary, and that table is neither.
 *
 * Everyone else keeps betting the live market. This only changes what YOU are
 * quoted, and only until the clock runs out.
 *
 * The price is the MODEL's, read here. It used to be whatever number the
 * request carried, which would have let a client lock any odds it liked.
 */
export async function lockInPrice({ slug, boostId, marketId, optionKey, priceNow = quoteNow }) {
  const [boost] = await sql`
    select id, owner, kind, used_at from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'lock-in') throw new Error('That boost does not lock a price.');

  const def = byKind[boost.kind];
  const [market] = await sql`
    select id, status, live, locks_at, season, week, kind, meta from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status !== 'open') throw new Error('That market is closed.');
  if (!market.live) {
    throw new Error('Only a live price moves. A pregame line is not going anywhere.');
  }
  if (new Date(market.locks_at) > new Date()) {
    throw new Error('That price is not live yet -- there is nothing moving to freeze.');
  }
  const [option] = await sql`
    select 1 from market_options where market_id = ${marketId} and option_key = ${optionKey}`;
  if (!option) throw new Error('No such option on this market.');

  const quote = await priceNow(market, optionKey);
  if (!quote) throw new Error('No live price -- the result is no longer in doubt.');
  const odds = quote.odds;

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

/**
 * Every unexpired, unclaimed lock this person holds, keyed by market id, so
 * the board can show the frozen number instead of the moving one.
 */
export async function lockedPrices(slug) {
  const rows = await sql`
    select target_market_id, detail from boosts
    where owner = ${slug} and kind = 'lock-in' and used_at is not null
      and (detail->>'expiresAt')::timestamptz > now()
      and detail->>'claimed' is null`;
  return Object.fromEntries(
    rows.map((r) => [
      String(r.target_market_id),
      { optionKey: r.detail.optionKey, odds: Number(r.detail.odds), expiresAt: r.detail.expiresAt },
    ]),
  );
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
 * The switch itself: moves a bet to a different option on its market.
 *
 * Split out of `switcheroo` so a crowd-funded one can do the same thing.
 * fireBounty used to insert a Switcheroo boost row and stop -- the bet never
 * moved, and the phantom row consumed the one-attack-per-bet slot, so 42
 * points bought a bet that was now safe from everyone.
 *
 * A straight bet has one market. A parlay has several, so a LEG is picked at
 * random first -- nobody can see the picks, so nobody can aim at the leg that
 * matters. Only legs still pending can move: a settled leg has a result, and
 * rewriting it would change history rather than the bet's future.
 *
 * Returns { detail } for the boost row.
 */
async function moveBet(victimBetId) {
  const [victim] = await sql`
    select id, market_id, option_key, is_parlay from bets where id = ${victimBetId}`;
  if (!victim) throw new Error('No such bet.');

  let legMarketId = victim.market_id;
  let fromOption = victim.option_key;
  let legCount = 0;

  if (victim.is_parlay) {
    const legs = await sql`
      select market_id, option_key from parlay_legs
      where bet_id = ${victimBetId} and status = 'pending'`;
    if (!legs.length) {
      throw new Error('Every leg of that parlay has already been decided.');
    }
    const leg = legs[Math.floor(Math.random() * legs.length)];
    legMarketId = leg.market_id;
    fromOption = leg.option_key;
    legCount = legs.length;
  }

  const others = await sql`
    select option_key, odds from market_options
    where market_id = ${legMarketId} and option_key <> ${fromOption}`;
  if (!others.length) throw new Error('That market has nowhere else to go.');

  // Random on a multi-way market; on a two-sided one there is only ever one
  // other option, so this is simply the flip.
  const pick = others[Math.floor(Math.random() * others.length)];

  if (victim.is_parlay) {
    // The leg moves and takes the new price with it. The parlay's combined
    // odds are recomputed from the legs at settlement.
    const [movedLeg] = await sql`
      update parlay_legs set option_key = ${pick.option_key}, odds = ${pick.odds}
      where bet_id = ${victimBetId} and market_id = ${legMarketId} and status = 'pending'
      returning market_id, option_key`;
    if (!movedLeg) throw new Error('That leg settled before the switch landed.');
  } else {
    const [moved] = await sql`
      update bets set option_key = ${pick.option_key}, odds = ${pick.odds}
      where id = ${victimBetId} and status = 'pending'
      returning id, option_key, odds`;
    if (!moved) throw new Error('That bet settled before the switch landed.');
  }

  return {
    to: pick.option_key,
    outOf: others.length,
    legs: legCount,
    detail: {
      from: fromOption,
      to: pick.option_key,
      choices: others.length,
      ...(victim.is_parlay
        ? { parlay: true, legMarketId: String(legMarketId), legs: legCount }
        : {}),
    },
  };
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

  // A parlay has no market_id, so the join above yields no season. Take it
  // from any leg instead -- without this, a mirrored parlay could not find the
  // attacker's own bet, and a bounty could not be claimed.
  let season = bet.season ?? null;
  if (season == null) {
    const [fromLeg] = await sql`
      select m.season from parlay_legs l join markets m on m.id = l.market_id
      where l.bet_id = ${betId} limit 1`;
    season = fromLeg?.season ?? null;
  }

  // Insurance blocks it like any other attack, and a mirror sends it back.
  const [shield] = await sql`
    select 1 from boosts where target_bet_id = ${betId} and kind = 'insurance'`;
  if (shield) throw new Error('That bet is insured.');

  const mirrored = await mirroredBets([Number(betId)]);
  let victimBetId = Number(betId);
  let reflected = false;
  if (mirrored[betId]) {
    const own = await biggestOpenBet(slug, season);
    if (!own) {
      throw new Error(
        'That bet is mirrored. With no open bet of your own there is nothing for it to ' +
          'rebound onto, so Switcheroo would simply be wasted.',
      );
    }
    victimBetId = own;
    reflected = true;
  }

  const moved = await moveBet(victimBetId);

  await sql`
    update boosts set target_bet_id = ${victimBetId}, used_at = now(),
                      detail = ${JSON.stringify({
                        ...moved.detail,
                        ...(reflected ? { reflected: true, aimedAt: String(betId) } : {}),
                      })}::jsonb
    where id = ${boostId} and used_at is null`;

  // A collective bounty fires itself, so a bought Switcheroo collects nothing --
  // and it cancels any bounty that was still raising for this bet.
  const collected = [];
  if (!reflected) await cancelBountiesOnBet(victimBetId);

  return {
    betId: String(victimBetId),
    to: moved.to,
    outOf: moved.outOf,
    reflected,
    // Which leg took it, for a parlay. 0 for a straight bet.
    legs: moved.legs,
    bounties: collected,
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
    select id, owner, kind, used_at, season from boosts where id = ${boostId}`;
  if (!boost) throw new Error('No such boost.');
  if (boost.owner !== slug) throw new Error('That is not yours.');
  if (boost.used_at) throw new Error('That boost has already been used.');
  if (boost.kind !== 'slow-play') throw new Error('That boost does not slow anyone down.');
  if (target === slug) throw new Error('Point that at someone else.');
  // A slow with no week is invisible to pendingSlowPlay forever -- it would sit
  // unspent and never fire, quietly eating the attacker's points. Checked on
  // the value itself, not Number(week): Number(null) is 0, which is finite, so
  // coercing first lets null straight through.
  if (week == null || !Number.isInteger(Number(week)) || Number(week) < 1) {
    throw new Error('Which week? That one is not valid.');
  }

  const [victim] = await sql`select slug from bettors where slug = ${target}`;
  if (!victim) throw new Error('No such manager.');

  // One pending slow at a time, regardless of which week it was thrown in.
  // The week filter that used to be here made sense while a slow expired at
  // the week boundary; now that one persists until it is worn off, checking
  // only this week would let them stack up on somebody who never bets big.
  const [clash] = await sql`
    select 1 from boosts
    where kind = 'slow-play' and target_bettor = ${target} and used_at is not null
      and detail->>'spent' is null`;
  if (clash) throw new Error('They are already slowed, and it has not worn off yet.');

  const [row] = await sql`
    update boosts set target_bettor = ${target}, used_at = now(),
                      detail = ${JSON.stringify({ week })}::jsonb
    where id = ${boostId} and used_at is null
    returning id`;
  if (!row) throw new Error('That boost has already been used.');

  // As above: nothing to claim, bounties buy the attack outright.
  return { target, week, bounties: [] };
}

/**
 * An unspent Slow Play against this manager, if any.
 *
 * Deliberately NOT scoped to the week it was thrown in. It was, and that meant
 * a slow quietly died at the week boundary: anyone hit late on a Sunday could
 * wait it out for free, and the attacker's 5 points bought nothing. It now
 * follows the victim until a bet actually wears it off.
 *
 * `week` is still taken, because the oldest pending slow should be the one
 * that fires, and because a slow thrown in a later week must not apply to a
 * bet being placed in an earlier one.
 */
export async function pendingSlowPlay(slug, week) {
  const [row] = await sql`
    select id from boosts
    where kind = 'slow-play' and target_bettor = ${slug} and used_at is not null
      and detail->>'spent' is null
      and (${week}::int is null or (detail->>'week')::int <= ${week})
    order by (detail->>'week')::int, id
    limit 1`;
  return row ? Number(row.id) : null;
}

/** Burns a Slow Play once the doubled bet is placed. */
export async function spendSlowPlay(boostId, betId) {
  await sql`
    update boosts set detail = detail || ${JSON.stringify({ spent: true, betId: String(betId) })}::jsonb
    where id = ${boostId}`;
}

/* ---------- bounties ---------- */

/**
 * Collective bounties: the crowd buys an attack, nobody buys a boost.
 *
 * The first version could not be priced. A hunter bought the weapon at list and
 * collected a reward, so they needed reward > cost, while the poster needed
 * reward < cost or they would simply buy it themselves. Those intervals never
 * overlap. There were no gains from trade: the hunter could do nothing the
 * poster could not do, at the same price.
 *
 * So there is no hunter. A bounty names a target, a weapon and a bet, and costs
 * exactly what that weapon costs in the shop. Anyone contributes. When the
 * contributions reach the price, the attack fires by itself and the bounty
 * closes. Nothing is resold, so there is nothing to misprice -- and an attack
 * nobody could afford alone becomes reachable when enough people agree.
 */

/** What the poster must put in: 20% of the price, nearest whole point, min 1. */
export function minimumStake(costPoints) {
  return Math.max(1, Math.round(Number(costPoints) * 0.2));
}

/**
 * Opens a bounty and seeds it with the poster's stake.
 *
 * The price is the weapon's shop cost -- not a number anyone types -- which is
 * what removes the pricing problem. The poster names the bet as well, so the
 * attack has somewhere unambiguous to land when it fires.
 */
export async function postBounty({ slug, season, week, target, weapon, betId, points }) {
  const def = byKind[weapon];
  if (!def?.attack) throw new Error('A bounty has to name an attack.');
  // Poison hits a MARKET, and a bounty names a person and maybe a bet. Firing
  // one wrote a boost row aimed at the person, which marketPenalty never
  // reads -- 36 points for nothing. Refused rather than half-built.
  if (def.target === TARGET.MARKET) {
    throw new Error(`${def.name} hits a market, not a person. It cannot be a bounty.`);
  }
  if (target === slug) throw new Error('You cannot put a bounty on yourself.');

  const [victim] = await sql`select slug, display_name from bettors where slug = ${target}`;
  if (!victim) throw new Error('No such manager.');

  const cost = Number(def.cost);
  const floor = minimumStake(cost);
  const seed = Math.round(Number(points ?? floor));
  if (!Number.isFinite(seed) || seed < floor) {
    throw new Error(`You have to put in at least ${floor} to post that -- 20% of ${cost}.`);
  }
  if (seed > cost) throw new Error(`That bounty only costs ${cost}.`);

  // Attacks that hit a BET need one named; the two that hit a person do not.
  const needsBet = def.target === TARGET.BET;
  let bet = null;
  if (needsBet) {
    if (betId == null) throw new Error(`${def.name} has to name a bet.`);
    const [row] = await sql`
      select b.id, b.bettor, b.status, b.market_id, b.is_parlay
      from bets b where b.id = ${betId}`;
    if (!row) throw new Error('No such bet.');
    if (row.bettor !== target) throw new Error('That bet is not theirs.');
    if (row.status !== 'pending') throw new Error('That bet has already settled.');

    // A bet that has already taken an attack cannot take another, so a bounty
    // for one could never fire. Refused here rather than letting people fund
    // something doomed.
    const [hit] = await sql`
      select kind from boosts
      where target_bet_id = ${betId} and kind = any(${ATTACK_KINDS})`;
    if (hit) {
      throw new Error(
        `That bet has already been hit with ${byKind[hit.kind]?.name ?? hit.kind}.`,
      );
    }

    const [shield] = await sql`
      select 1 from boosts where target_bet_id = ${betId} and kind = 'insurance'`;
    if (shield) throw new Error('That bet is insured -- nothing would get through.');

    bet = row;
  }

  const held = await getPoints(slug, season);
  if (held < seed) {
    throw new Error(`Not enough points. That costs ${seed} to post, you have ${held}.`);
  }

  const [clash] = await sql`
    select id from bounties
    where season = ${season} and week = ${week} and target = ${target}
      and weapon = ${weapon} and coalesce(bet_id, -1) = ${bet ? Number(bet.id) : -1}
      and status = 'open'`;
  if (clash) throw new Error(`There is already a ${def.name} bounty on that.`);

  const [row] = await sql`
    insert into bounties (season, week, poster, target, weapon, bet_id, cost_points, status)
    values (${season}, ${week}, ${slug}, ${target}, ${weapon},
            ${bet ? Number(bet.id) : null}, ${cost}, 'open')
    returning id, posted_at`;

  // The poster's own stake goes through the same path as anyone else's, so
  // there is one place where contributions are escrowed and totalled.
  const state = await contributeToBounty({ slug, season, bountyId: Number(row.id), points: seed });

  return {
    id: String(row.id),
    target: victim.display_name,
    weapon: def.name,
    cost,
    ...state,
    alert:
      `BOUNTY ALERT: A bounty has been placed on ${victim.display_name.toUpperCase()} ` +
      `ATTACK: ${def.name} REWARD: ${cost} Points`,
  };
}

/** What a bounty has raised so far. Summed, never stored. */
export async function bountyTotal(bountyId) {
  const [row] = await sql`
    select coalesce(sum(points), 0)::int as raised
    from bounty_contributions where bounty_id = ${bountyId}`;
  return Number(row?.raised ?? 0);
}

/**
 * Puts points into an open bounty, and fires it if that fills it.
 *
 * Points are escrowed on the way in, exactly as the old reward was: a pledge
 * nobody can cover is not a pledge.
 */
export async function contributeToBounty({ slug, season, bountyId, points }) {
  const amount = Math.round(Number(points));
  if (!Number.isFinite(amount) || amount < 1) throw new Error('Put in at least a point.');

  const [b] = await sql`select * from bounties where id = ${bountyId}`;
  if (!b) throw new Error('No such bounty.');
  if (b.status !== 'open') throw new Error('That bounty is closed.');
  if (b.target === slug) throw new Error('You cannot fund a bounty on yourself.');

  const cost = Number(b.cost_points);
  const raised = await bountyTotal(bountyId);
  const room = cost - raised;
  if (room <= 0) throw new Error('That bounty is already fully funded.');

  // Overpaying would mean refunding change later. Cap it instead and say so.
  const take = Math.min(amount, room);

  const held = await getPoints(slug, season);
  if (held < take) throw new Error(`Not enough points. You have ${held}.`);

  await sql`
    insert into point_ledger (bettor, season, amount, reason, note)
    values (${slug}, ${season}, ${-take}, 'purchase', ${'Bounty contribution'})`;

  // One row per person: topping up adds to it, so "split by what each put in"
  // has one answer per contributor.
  await sql`
    insert into bounty_contributions (bounty_id, contributor, points)
    values (${bountyId}, ${slug}, ${take})
    on conflict (bounty_id, contributor)
    do update set points = bounty_contributions.points + ${take}`;

  // Two people filling the last gap at once both pass the `room` check above
  // -- there are no transactions on this driver -- and the bounty ends up
  // holding more than it costs. Whatever this contribution pushed past the
  // price comes straight back to its contributor.
  let now = await bountyTotal(bountyId);
  let kept = take;
  if (now > cost) {
    const over = Math.min(take, now - cost);
    kept = take - over;
    await sql`
      update bounty_contributions set points = points - ${over}
      where bounty_id = ${bountyId} and contributor = ${slug}`;
    await sql`delete from bounty_contributions where bounty_id = ${bountyId} and points <= 0`;
    await sql`
      insert into point_ledger (bettor, season, amount, reason, note)
      values (${slug}, ${season}, ${over}, 'refund', ${'Bounty was already full'})`;
    now = await bountyTotal(bountyId);
  }

  let fired = null;
  if (now >= cost) fired = await fireBounty(bountyId);

  return { raised: now, cost, funded: now >= cost, contributed: kept, fired };
}

/**
 * Fires a fully funded bounty: the attack lands, the bounty closes.
 *
 * The attack is written directly rather than routed through useBoostOnBet,
 * because nobody owns a boost here -- the crowd bought the effect, not an item.
 * A boost row is still created so settlement, Receipt and the payout maths all
 * see it exactly as they would any other attack.
 */
export async function fireBounty(bountyId) {
  const [b] = await sql`select * from bounties where id = ${bountyId} and status = 'open'`;
  if (!b) return null;

  const def = byKind[b.weapon];
  if (!def) throw new Error('That bounty names an attack that no longer exists.');

  // The named bet has to still be live. If it settled while the bounty was
  // filling there is nothing to attack, so the whole thing is refunded.
  if (b.bet_id != null) {
    const [bet] = await sql`select id, status from bets where id = ${b.bet_id}`;
    if (!bet || bet.status !== 'pending') {
      await refundBounty(bountyId, 'the bet settled before it filled');
      return { refunded: true, why: 'the bet settled before it filled' };
    }
    // Insurance blocks a bounty exactly as it blocks a bought attack.
    const [shield] = await sql`
      select 1 from boosts where target_bet_id = ${b.bet_id} and kind = 'insurance'`;
    if (shield) {
      await refundBounty(bountyId, 'the bet was insured');
      return { refunded: true, why: 'the bet was insured' };
    }
  }

  // A Mirror sends a bought attack back at the attacker. A crowd has no single
  // attacker, so it rebounds onto the POSTER -- they named the target -- and
  // with nothing of theirs to land on the bounty is refunded, exactly as a
  // bought attack is refused.
  let landsOn = b.bet_id;
  let reflected = false;
  if (b.bet_id != null) {
    const mirrored = await mirroredBets([Number(b.bet_id)]);
    if (mirrored[b.bet_id]) {
      const own = await biggestOpenBet(b.poster, Number(b.season));
      if (!own) {
        await refundBounty(bountyId, 'the bet was mirrored and the poster had nothing to rebound onto');
        return { refunded: true, why: 'the bet was mirrored' };
      }
      landsOn = own;
      reflected = true;
    }
  }

  // Switcheroo is the one attack that changes the bet NOW rather than at
  // settlement. Inserting the row alone never moved anything.
  let moved = null;
  if (def.flips) moved = await moveBet(landsOn);

  // A boost row with no owner: `bounty` marks it as crowd-funded, which is what
  // the payout split and Receipt both key off.
  const [boost] = await sql`
    insert into boosts (owner, season, kind, cost_points, target_bet_id, target_bettor,
                        used_at, detail)
    values (${b.poster}, ${b.season}, ${b.weapon}, ${Number(b.cost_points)},
            ${landsOn}, ${b.bet_id == null ? b.target : null}, now(),
            ${JSON.stringify({
              bounty: String(bountyId),
              week: Number(b.week),
              ...(moved?.detail ?? {}),
              ...(reflected ? { reflected: true, aimedAt: String(b.bet_id) } : {}),
            })}::jsonb)
    returning id`;

  await sql`
    update bounties set status = 'fired', fired_at = now(), claim_boost_id = ${boost.id}
    where id = ${bountyId}`;

  return { fired: true, boostId: String(boost.id), weapon: def.name, reflected };
}

/**
 * Cancels any open bounty aimed at a bet somebody has just attacked directly.
 *
 * An individual attack overrides a bounty: the bet has been hit, so a bounty
 * still raising for it can never land. Everyone who chipped in is refunded.
 * Deliberately not counted as the bounty having "worked" -- the person who paid
 * out of pocket did it, not the crowd.
 */
export async function cancelBountiesOnBet(betId) {
  const rows = await sql`
    select id from bounties where bet_id = ${betId} and status = 'open'`;
  for (const r of rows) {
    await refundBounty(Number(r.id), 'somebody attacked that bet first');
  }
  return rows.length;
}

/** Closes a bounty and hands every contributor their points back. */
export async function refundBounty(bountyId, why) {
  const [b] = await sql`select * from bounties where id = ${bountyId}`;
  if (!b || b.status !== 'open') return 0;

  const rows = await sql`
    select contributor, points from bounty_contributions where bounty_id = ${bountyId}`;
  for (const r of rows) {
    await sql`
      insert into point_ledger (bettor, season, amount, reason, note)
      values (${r.contributor}, ${b.season}, ${Number(r.points)}, 'refund',
              ${'Bounty refunded -- ' + why})`;
  }
  await sql`
    update bounties set status = 'void', closed_reason = ${why} where id = ${bountyId}`;
  return rows.length;
}

/** Open bounties for a week, with what each has raised and who chipped in. */
export async function openBounties(season, week) {
  const rows = await sql`
    select b.id, b.target, b.weapon, b.bet_id, b.cost_points, b.posted_at, b.poster,
           t.display_name as target_name,
           p.display_name as poster_name,
           coalesce(sum(c.points), 0)::int as raised,
           count(c.id)::int as backers
    from bounties b
    join bettors t on t.slug = b.target
    join bettors p on p.slug = b.poster
    left join bounty_contributions c on c.bounty_id = b.id
    where b.season = ${season} and b.week = ${week} and b.status = 'open'
    group by b.id, b.target, b.weapon, b.bet_id, b.cost_points, b.posted_at, b.poster,
             t.display_name, p.display_name
    order by (coalesce(sum(c.points), 0)::float / nullif(b.cost_points, 0)) desc,
             b.posted_at desc`;
  return rows.map((r) => ({
    ...r,
    id: String(r.id),
    cost_points: Number(r.cost_points),
    raised: Number(r.raised),
    remaining: Math.max(0, Number(r.cost_points) - Number(r.raised)),
  }));
}

/** Who has put into a bounty, most first. Drives the payout split. */
export async function bountyBackers(bountyId) {
  const rows = await sql`
    select c.contributor, c.points, c.created_at, t.display_name
    from bounty_contributions c
    join bettors t on t.slug = c.contributor
    where c.bounty_id = ${bountyId}
    order by c.points desc, c.created_at`;
  return rows.map((r) => ({ ...r, points: Number(r.points) }));
}

/**
 * Splits a stolen payout between the people who funded the theft.
 *
 * Grand Theft is the only attack that pays anything out -- it redirects the
 * victim's whole payout to the thief. With no single thief, it goes to the
 * backers in proportion to what each put in.
 *
 * Largest share takes the rounding remainder, earliest on a tie, so the parts
 * always add back up to the payout exactly. Returns [{slug, cents}].
 */
export async function splitBountyPayout(bountyId, payoutCents) {
  const backers = await bountyBackers(bountyId);
  const total = backers.reduce((n, b) => n + b.points, 0);
  if (!backers.length || total <= 0) return [];

  const shares = backers.map((b) => ({
    slug: b.contributor,
    cents: Math.floor((payoutCents * b.points) / total),
  }));
  const given = shares.reduce((n, s) => n + s.cents, 0);
  if (given < payoutCents) shares[0].cents += payoutCents - given;
  return shares.filter((s) => s.cents > 0);
}

/**
 * Closes out a week's bounties that never filled.
 *
 * Full refund, by decision: an unfilled bounty is nobody's fault, and charging
 * for it would make people lowball rather than post a real one.
 */
export async function expireBounties(season, week) {
  const rows = await sql`
    select id from bounties
    where season = ${season} and week = ${week} and status = 'open'`;
  for (const r of rows) await refundBounty(Number(r.id), 'nobody filled it');
  return rows.length;
}

/**
 * Kills any open bounty whose named bet is no longer live.
 *
 * Runs from the cron. A bounty tied to a bet that settled, voided or was undone
 * can never fire, so holding everyone's points hostage until the week rolls
 * would be pointless.
 */
export async function cullDeadBountyBets(season, week) {
  const rows = await sql`
    select b.id from bounties b
    join bets t on t.id = b.bet_id
    where b.season = ${season} and b.week = ${week} and b.status = 'open'
      and t.status <> 'pending'`;
  for (const r of rows) await refundBounty(Number(r.id), 'the bet settled before it filled');
  return rows.length;
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

  // A parlay has no market_id, so the join above never finds it: Big Week
  // and the curse silently skipped every parlay. Its week is the earliest of
  // its legs -- the week its stake came out of.
  const parlayWide = await sql`
    select b.id as bet_id, bo.kind
    from bets b
    join (
      select l.bet_id, min(m.season) as season, min(m.week) as week
      from parlay_legs l join markets m on m.id = l.market_id
      group by l.bet_id
    ) pw on pw.bet_id = b.id
    join boosts bo
      on bo.season = pw.season
     and (bo.detail->>'week')::int = pw.week
     and bo.used_at is not null
     and (
       (bo.owner = b.bettor and bo.kind = 'boost-week')
       or (bo.target_bettor = b.bettor and bo.kind = 'week-curse')
     )
    where b.id = any(${ids}) and b.is_parlay`;

  const byBet = {};
  for (const r of attached) (byBet[r.target_bet_id] ??= []).push(r.kind);
  for (const r of [...weekWide, ...parlayWide]) {
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
/**
 * Who is owed a share of each bet's winnings.
 *
 * Cut of the Action leaves the bet alone -- the owner still wins and still
 * banks -- and takes a slice of the PROFIT. Deliberately not a slice of the
 * payout: that would take part of their stake back too, so a "win" could leave
 * them down, which is not what a 5-point boost should do.
 *
 * Insurance blocks it like any other attack. Returns
 * { [betId]: [{ slug, bountyId, share }] } -- several people can tithe one bet.
 */
export async function tithesFor(betIds) {
  if (!betIds?.length) return {};
  const ids = betIds.map(Number);
  const rows = await sql`
    select b.target_bet_id, b.owner, b.kind, b.detail->>'bounty' as bounty_id
    from boosts b
    where b.target_bet_id = any(${ids}) and b.kind = 'tithe'
      and not exists (
        select 1 from boosts s
        where s.target_bet_id = b.target_bet_id and s.kind = 'insurance'
      )`;
  const byBet = {};
  for (const r of rows) {
    (byBet[r.target_bet_id] ??= []).push({
      slug: r.owner,
      bountyId: r.bounty_id ? Number(r.bounty_id) : null,
      share: byKind[r.kind]?.tithes ?? 0.5,
    });
  }
  return byBet;
}

export async function thievesFor(betIds) {
  if (!betIds?.length) return {};
  const ids = betIds.map(Number);
  const rows = await sql`
    select b.target_bet_id, b.owner, b.detail->>'bounty' as bounty_id
    from boosts b
    where b.target_bet_id = any(${ids}) and b.kind = 'steal'
      and not exists (
        select 1 from boosts s
        where s.target_bet_id = b.target_bet_id and s.kind = 'insurance'
      )`;
  // A crowd-funded steal has no single thief: the payout is split between the
  // people who paid for it, so the bounty id travels with the owner.
  return Object.fromEntries(
    rows.map((r) => [
      r.target_bet_id,
      { slug: r.owner, bountyId: r.bounty_id ? Number(r.bounty_id) : null },
    ]),
  );
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

/**
 * What is currently bending the board, for the banner at the top of it.
 *
 * Deliberately NOT every boost. A Skim on somebody's bet is between them and
 * whoever threw it, and posting it would turn the board into a feed. This is
 * only the things that change what a market is worth to EVERYONE looking at it,
 * plus the week-wide multipliers, which are public by design.
 *
 * Everything here is already public somewhere else -- Poison advertises itself,
 * Big Week and the curse both alter a whole week's settlement. Collecting them
 * in one place is a presentation change, not a disclosure.
 *
 * Blind attacks on individual bets are excluded on purpose: their whole value
 * is that the victim does not know, and naming them here would refund the
 * attacker's points in information.
 */
export async function marketEffects(season, week) {
  // Price effects: poisoning, which everyone pays.
  const poisoned = await sql`
    select b.target_market_id as market_id, b.kind, m.title, t.display_name as by_name
    from boosts b
    join markets m on m.id = b.target_market_id
    join bettors t on t.slug = b.owner
    where m.season = ${season} and m.week = ${week}
      and b.kind = 'market-poison'
      and b.used_at is not null
    order by m.title`;

  // Week-wide settlement multipliers. Both are public: one is bought for
  // yourself, the other is thrown at someone, and neither is a secret.
  const weekly = await sql`
    select b.kind, b.owner, b.target_bettor,
           o.display_name as owner_name, v.display_name as target_name
    from boosts b
    left join bettors o on o.slug = b.owner
    left join bettors v on v.slug = b.target_bettor
    where b.season = ${season}
      and (b.detail->>'week')::int = ${week}
      and b.used_at is not null
      and b.kind in ('boost-week', 'week-curse', 'slow-play')
      -- A spent Slow Play has already bitten; only a pending one is "in play".
      and (b.kind <> 'slow-play' or b.detail->>'spent' is null)`;

  return {
    markets: poisoned.map((r) => ({
      marketId: String(r.market_id),
      title: r.title,
      kind: r.kind,
      by: r.by_name,
      bump: byKind[r.kind]?.marginBump ?? 0,
    })),
    weekly: weekly.map((r) => ({
      kind: r.kind,
      // An attack names its VICTIM -- the person everyone wants to know about.
      // A self-boost names its owner, because they are the same person.
      who: r.kind === 'boost-week' ? r.owner_name : r.target_name,
      by: r.kind === 'boost-week' ? null : r.owner_name,
      // Read from the catalogue so the banner cannot quote a number that
      // settlement no longer uses.
      pct:
        r.kind === 'week-curse'
          ? Math.round((byKind[r.kind]?.payoutCut ?? 0) * 100)
          : Math.round(((byKind[r.kind]?.multiplier ?? 1) - 1) * 100),
      // Slow Play quotes a stake floor rather than a percentage.
      minStake: byKind[r.kind]?.minStakeDollars ?? null,
    })),
  };
}
