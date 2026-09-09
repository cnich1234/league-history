import { neon } from '@neondatabase/serverless';
import { payoutCents, MIN_STAKE_CENTS, MAX_STAKE_CENTS } from './odds.js';

const sql = neon(process.env.DATABASE_URL);

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
  if (market.status === 'settled') throw new Error('Market is already settled.');

  const bets = await sql`
    select id, bettor, option_key, stake_cents, odds
    from bets where market_id = ${marketId} and status = 'pending'`;

  let paid = 0;
  for (const bet of bets) {
    const push = winningOption === 'push';
    const won = bet.option_key === winningOption;
    const status = push ? 'push' : won ? 'won' : 'lost';
    const payout = push ? Number(bet.stake_cents) : won ? payoutCents(Number(bet.stake_cents), bet.odds) : 0;

    await sql`
      update bets set status = ${status}, payout_cents = ${payout}, settled_at = now()
      where id = ${bet.id}`;

    if (payout > 0) {
      await sql`
        insert into ledger (bettor, amount_cents, reason, bet_id, note)
        values (${bet.bettor}, ${payout}, ${push ? 'refund' : 'payout'}, ${bet.id},
                ${push ? 'Push - stake returned' : 'Winning bet'})`;
      paid += payout;
    }
  }

  await sql`
    update markets set status = 'settled', winning_option = ${winningOption}, settled_at = now()
    where id = ${marketId}`;

  return { settled: bets.length, paidCents: paid };
}

/** Locks any market whose time has passed. Safe to run repeatedly. */
export async function lockDueMarkets() {
  const rows = await sql`
    update markets set status = 'locked'
    where status = 'open' and locks_at <= now()
    returning id, title`;
  return rows;
}
