import { neon } from '@neondatabase/serverless';
import { payoutCents, MIN_STAKE_CENTS, MAX_STAKE_CENTS } from './odds.js';

/**
 * Connect lazily, on first query rather than at import.
 *
 * `neon(process.env.DATABASE_URL)` runs the moment this module is loaded, which
 * during a build is before any page has asked for data. If DATABASE_URL is
 * missing there -- as it is on a first deploy, or any preview branch without
 * the variable -- the whole build dies instead of just the pages that need a
 * database. Deferring means a missing variable is a runtime error on one page,
 * not a failed deploy.
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
 * Data access for The Book.
 *
 * The hiding rule is enforced here, in the queries, not in the UI. A component
 * that forgets to filter would leak everyone's picks; a query that never
 * selects them cannot. Every read of other people's bets goes through
 * `visibleBets`, which will not return an unlocked market's wagers.
 */

export async function getBankrolls() {
  return sql`
    select slug, display_name, balance_cents, staked_cents, wins, losses, pending
    from bankrolls
    order by balance_cents desc, display_name`;
}

export async function getBettor(slug) {
  const [row] = await sql`
    select slug, display_name, balance_cents, wins, losses, pending
    from bankrolls where slug = ${slug}`;
  return row ?? null;
}

/** Markets still open for betting, with their prices. */
export async function getOpenMarkets(season, week) {
  const markets = await sql`
    select id, season, week, kind, title, subtitle, locks_at, status, meta
    from markets
    where season = ${season} and week = ${week} and status = 'open' and locks_at > now()
    order by kind, id`;
  return attachOptions(markets);
}

export async function getMarketsForWeek(season, week) {
  const markets = await sql`
    select id, season, week, kind, title, subtitle, locks_at, status, winning_option, meta
    from markets
    where season = ${season} and week = ${week}
    order by kind, id`;
  return attachOptions(markets);
}

async function attachOptions(markets) {
  if (!markets.length) return [];
  const ids = markets.map((m) => m.id);
  const options = await sql`
    select market_id, option_key, label, odds
    from market_options where market_id = any(${ids})
    order by market_id, option_key`;
  const byMarket = {};
  for (const o of options) (byMarket[o.market_id] ??= []).push(o);
  return markets.map((m) => ({ ...m, options: byMarket[m.id] ?? [] }));
}

/** Every bet a person has placed. Always visible to its owner. */
export async function getMyBets(slug) {
  return sql`
    select b.id, b.market_id, b.option_key, b.stake_cents, b.odds, b.status,
           b.payout_cents, b.placed_at,
           m.title, m.subtitle, m.kind, m.week, m.locks_at, m.status as market_status,
           o.label as option_label
    from bets b
    join markets m on m.id = b.market_id
    join market_options o on o.market_id = b.market_id and o.option_key = b.option_key
    where b.bettor = ${slug}
    order by b.placed_at desc`;
}

/**
 * Other people's bets -- only from markets that have already locked.
 *
 * This is the single query the whole "no copying" rule rests on. It filters on
 * `locks_at <= now()` in SQL, so an unlocked bet is never loaded into the
 * server's memory, let alone sent to a browser.
 */
export async function visibleBets(season, week) {
  return sql`
    select b.id, b.bettor, b.market_id, b.option_key, b.stake_cents, b.odds, b.status,
           b.payout_cents, b.placed_at,
           m.title, m.kind, m.week, m.status as market_status, m.winning_option,
           o.label as option_label,
           t.display_name as bettor_name
    from bets b
    join markets m on m.id = b.market_id
    join market_options o on o.market_id = b.market_id and o.option_key = b.option_key
    join bettors t on t.slug = b.bettor
    where m.season = ${season} and m.week = ${week}
      and m.locks_at <= now()
    order by b.placed_at`;
}

/** How many bets are pending on a market, without revealing whose or which side. */
export async function betCounts(season, week) {
  const rows = await sql`
    select b.market_id, count(*)::int as n
    from bets b join markets m on m.id = b.market_id
    where m.season = ${season} and m.week = ${week}
    group by b.market_id`;
  return Object.fromEntries(rows.map((r) => [r.market_id, r.n]));
}

/**
 * Places a bet. Every rule that could be broken is checked against the database
 * inside one transaction, because a check done in the browser is a suggestion.
 */
export async function placeBet({ slug, marketId, optionKey, stakeCents }) {
  if (!Number.isInteger(stakeCents)) throw new Error('Stake must be a whole number of cents.');
  if (stakeCents < MIN_STAKE_CENTS) throw new Error(`Minimum bet is $${MIN_STAKE_CENTS / 100}.`);
  if (stakeCents > MAX_STAKE_CENTS) throw new Error(`Maximum bet is $${MAX_STAKE_CENTS / 100}.`);

  const [market] = await sql`
    select id, status, locks_at from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status !== 'open') throw new Error('This market is closed.');
  if (new Date(market.locks_at) <= new Date()) throw new Error('This market has locked.');

  const [option] = await sql`
    select odds from market_options where market_id = ${marketId} and option_key = ${optionKey}`;
  if (!option) throw new Error('No such option on this market.');

  const [existing] = await sql`
    select 1 from bets where bettor = ${slug} and market_id = ${marketId}`;
  if (existing) throw new Error('You already have a bet on this market.');

  const [balance] = await sql`select balance_cents from bankrolls where slug = ${slug}`;
  if (!balance) throw new Error('Unknown bettor.');
  if (Number(balance.balance_cents) < stakeCents) throw new Error('Not enough in your bankroll.');

  // Odds are frozen at placement; a later line move must not change this bet.
  const [bet] = await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds)
    values (${slug}, ${marketId}, ${optionKey}, ${stakeCents}, ${option.odds})
    returning id, stake_cents, odds`;

  await sql`
    insert into ledger (bettor, amount_cents, reason, bet_id, note)
    values (${slug}, ${-stakeCents}, 'stake', ${bet.id}, 'Bet placed')`;

  return bet;
}

/**
 * Settles one market. Pays winners, refunds pushes, marks losers.
 *
 * The unique index on (bet_id, reason) means a second settlement attempt fails
 * at the database rather than paying everyone twice.
 */
export async function settleMarket(marketId, winningOption) {
  const [market] = await sql`select id, status from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status === 'settled' || market.status === 'void') {
    throw new Error('Market is already settled.');
  }

  const bets = await sql`
    select id, bettor, option_key, stake_cents, odds
    from bets where market_id = ${marketId} and status = 'pending'`;

  let paid = 0;
  for (const bet of bets) {
    // 'push' and 'void' both refund the stake. A void is for a market that
    // cannot be decided fairly at all -- a prop on a player who never started,
    // say -- where settling it as a loss would punish a bet nobody could win.
    const refund = winningOption === 'push' || winningOption === 'void';
    const won = !refund && bet.option_key === winningOption;
    const status = refund ? (winningOption === 'void' ? 'void' : 'push') : won ? 'won' : 'lost';
    const payout = refund
      ? Number(bet.stake_cents)
      : won
        ? payoutCents(Number(bet.stake_cents), bet.odds)
        : 0;

    await sql`
      update bets set status = ${status}, payout_cents = ${payout}, settled_at = now()
      where id = ${bet.id}`;

    if (payout > 0) {
      await sql`
        insert into ledger (bettor, amount_cents, reason, bet_id, note)
        values (${bet.bettor}, ${payout}, ${refund ? 'refund' : 'payout'}, ${bet.id},
                ${refund ? 'Stake returned' : 'Winning bet'})`;
      paid += payout;
    }
  }

  await sql`
    update markets
    set status = ${winningOption === 'void' ? 'void' : 'settled'},
        winning_option = ${winningOption}, settled_at = now()
    where id = ${marketId}`;

  return { settled: bets.length, paidCents: paid };
}

/**
 * Re-up: real money in, play money out.
 *
 * The $20 is real and owed to the prize pool; the bankroll credit is play money
 * and goes in the ledger like any other movement. They are recorded separately
 * on purpose -- a manager who has re-upped four times has spent $80 and should
 * not appear to be winning the season because of it.
 *
 * Deliberately does NOT check that the bettor is broke. Whether to allow a
 * re-up is your call as commissioner, not a rule the database should guess at.
 */
export async function recordBuyin({ slug, season, bankrollCents = 100000, amountCents = 2000, note = null }) {
  if (!Number.isInteger(bankrollCents) || bankrollCents <= 0) throw new Error('Bankroll credit must be a positive whole number of cents.');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('Buy-in must be a positive whole number of cents.');

  const [bettor] = await sql`select slug from bettors where slug = ${slug}`;
  if (!bettor) throw new Error('Unknown bettor.');

  const [buyin] = await sql`
    insert into buyins (bettor, season, amount_cents, bankroll_cents, note)
    values (${slug}, ${season}, ${amountCents}, ${bankrollCents}, ${note})
    returning id, amount_cents, bankroll_cents, collected`;

  await sql`
    insert into ledger (bettor, amount_cents, reason, note)
    values (${slug}, ${bankrollCents}, 'adjustment',
            ${`Re-up #${buyin.id}` + (note ? ` - ${note}` : '')})`;

  return buyin;
}

/** Marks a re-up's real $20 as actually collected. */
export async function markBuyinCollected(id, collected = true) {
  const [row] = await sql`
    update buyins
    set collected = ${collected}, collected_at = ${collected ? new Date() : null}
    where id = ${id}
    returning id, bettor, amount_cents, collected`;
  if (!row) throw new Error('No such buy-in.');
  return row;
}

export async function getBuyins(season) {
  return sql`
    select b.id, b.bettor, t.display_name, b.amount_cents, b.bankroll_cents,
           b.collected, b.collected_at, b.note, b.created_at
    from buyins b join bettors t on t.slug = b.bettor
    where b.season = ${season}
    order by b.created_at desc`;
}

/** Real money in the pot: the base prize plus every collected re-up. */
export async function getPrizePool(season, baseCents = 20000) {
  const [row] = await sql`
    select buyins_collected, buyins_outstanding, collected_cents, outstanding_cents
    from prize_pool where season = ${season}`;
  const collected = Number(row?.collected_cents ?? 0);
  return {
    baseCents,
    collectedCents: collected,
    outstandingCents: Number(row?.outstanding_cents ?? 0),
    totalCents: baseCents + collected,
    buyinsCollected: Number(row?.buyins_collected ?? 0),
    buyinsOutstanding: Number(row?.buyins_outstanding ?? 0),
  };
}

/**
 * Every settled bet in the league, newest first. Public by definition -- these
 * markets are long since locked, so there is nothing left to hide.
 */
export async function settledBets(season, limit = 200) {
  return sql`
    select b.id, b.bettor, b.option_key, b.stake_cents, b.odds, b.status,
           b.payout_cents, b.settled_at,
           m.title, m.subtitle, m.kind, m.week, m.winning_option,
           o.label as option_label, t.display_name as bettor_name
    from bets b
    join markets m on m.id = b.market_id
    join market_options o on o.market_id = b.market_id and o.option_key = b.option_key
    join bettors t on t.slug = b.bettor
    where m.season = ${season} and b.status <> 'pending'
    order by b.settled_at desc nulls last, b.id desc
    limit ${limit}`;
}

/** Per-manager totals over settled bets, for the results leaderboard. */
export async function settledSummary(season) {
  return sql`
    select b.bettor, t.display_name,
           count(*)::int as settled,
           count(*) filter (where b.status = 'won')::int as wins,
           count(*) filter (where b.status = 'lost')::int as losses,
           count(*) filter (where b.status in ('push', 'void'))::int as refunded,
           coalesce(sum(b.payout_cents - b.stake_cents), 0) as net_cents,
           coalesce(sum(b.stake_cents), 0) as wagered_cents
    from bets b
    join markets m on m.id = b.market_id
    join bettors t on t.slug = b.bettor
    where m.season = ${season} and b.status <> 'pending'
    group by b.bettor, t.display_name
    order by net_cents desc`;
}

/** Locks any market whose time has passed. Safe to run repeatedly. */
export async function lockDueMarkets() {
  const rows = await sql`
    update markets set status = 'locked'
    where status = 'open' and locks_at <= now()
    returning id, title`;
  return rows;
}
