import { neon } from '@neondatabase/serverless';
import {
  payoutCents,
  parlayOdds,
  MIN_STAKE_CENTS,
  MAX_STAKE_CENTS,
  MIN_PARLAY_LEGS,
  MAX_PARLAY_LEGS,
} from './odds.js';

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
 * Places a parlay: several legs, all of which must win.
 *
 * The whole slip locks when its EARLIEST leg does. Put a Thursday prop in a
 * parlay and the entire thing has to be built by Wednesday night -- otherwise
 * you could add legs after that prop had already played.
 */
export async function placeParlay({ slug, legs, stakeCents }) {
  if (!Number.isInteger(stakeCents)) throw new Error('Stake must be a whole number of cents.');
  if (stakeCents < MIN_STAKE_CENTS) throw new Error(`Minimum bet is $${MIN_STAKE_CENTS / 100}.`);
  if (stakeCents > MAX_STAKE_CENTS) throw new Error(`Maximum bet is $${MAX_STAKE_CENTS / 100}.`);
  if (!Array.isArray(legs) || legs.length < MIN_PARLAY_LEGS) {
    throw new Error(`A parlay needs at least ${MIN_PARLAY_LEGS} legs.`);
  }
  if (legs.length > MAX_PARLAY_LEGS) {
    throw new Error(`A parlay can have at most ${MAX_PARLAY_LEGS} legs.`);
  }

  const marketIds = legs.map((l) => Number(l.marketId));
  if (new Set(marketIds).size !== marketIds.length) {
    // Two legs on one market is either a mistake or an attempt to bet both
    // sides, which can never win.
    throw new Error('Each leg must be a different market.');
  }

  const markets = await sql`
    select id, status, locks_at from markets where id = any(${marketIds})`;
  if (markets.length !== marketIds.length) throw new Error('A market in this parlay no longer exists.');

  const now = new Date();
  for (const m of markets) {
    if (m.status !== 'open') throw new Error('A market in this parlay is closed.');
    if (new Date(m.locks_at) <= now) throw new Error('A market in this parlay has locked.');
  }

  const options = await sql`
    select market_id, option_key, odds from market_options where market_id = any(${marketIds})`;
  const priced = legs.map((leg) => {
    const o = options.find(
      (x) => Number(x.market_id) === Number(leg.marketId) && x.option_key === leg.optionKey,
    );
    if (!o) throw new Error('A leg names an option that does not exist.');
    return { marketId: Number(leg.marketId), optionKey: leg.optionKey, odds: o.odds };
  });

  const combined = parlayOdds(priced.map((l) => l.odds));

  const [balance] = await sql`select balance_cents from bankrolls where slug = ${slug}`;
  if (!balance) throw new Error('Unknown bettor.');
  if (Number(balance.balance_cents) < stakeCents) throw new Error('Not enough in your bankroll.');

  const [bet] = await sql`
    insert into bets (bettor, stake_cents, odds, is_parlay, parlay_odds)
    values (${slug}, ${stakeCents}, ${combined}, true, ${combined})
    returning id, stake_cents, odds`;

  for (const leg of priced) {
    await sql`
      insert into parlay_legs (bet_id, market_id, option_key, odds)
      values (${bet.id}, ${leg.marketId}, ${leg.optionKey}, ${leg.odds})`;
  }

  await sql`
    insert into ledger (bettor, amount_cents, reason, bet_id, note)
    values (${slug}, ${-stakeCents}, 'stake', ${bet.id}, ${`${priced.length}-leg parlay`})`;

  return { ...bet, legs: priced.length, combinedOdds: combined };
}

/**
 * Resolves any parlay whose legs are now all decided.
 *
 * Called after each market settles. A parlay dies the moment one leg loses --
 * no point waiting for the rest -- but only pays once every leg is in.
 *
 * A void or pushed leg drops out of the parlay and the remaining legs are
 * re-priced, which is what a real book does. A two-leg parlay with one void leg
 * becomes a straight bet on the survivor rather than being refunded whole.
 */
export async function settleParlays() {
  const pending = await sql`
    select distinct b.id, b.bettor, b.stake_cents
    from bets b
    join parlay_legs l on l.bet_id = b.id
    where b.is_parlay = true and b.status = 'pending'`;

  let settled = 0;
  let paid = 0;

  for (const bet of pending) {
    const legs = await sql`
      select market_id, option_key, odds, status from parlay_legs where bet_id = ${bet.id}`;

    if (legs.some((l) => l.status === 'lost')) {
      await sql`
        update bets set status = 'lost', payout_cents = 0, settled_at = now()
        where id = ${bet.id}`;
      settled++;
      continue;
    }

    if (legs.some((l) => l.status === 'pending')) continue;

    // Every leg is in and none lost. Voided and pushed legs drop out.
    const live = legs.filter((l) => l.status === 'won');
    if (!live.length) {
      // Every leg voided: refund.
      await sql`
        update bets set status = 'void', payout_cents = ${Number(bet.stake_cents)}, settled_at = now()
        where id = ${bet.id}`;
      await sql`
        insert into ledger (bettor, amount_cents, reason, bet_id, note)
        values (${bet.bettor}, ${Number(bet.stake_cents)}, 'refund', ${bet.id}, 'Parlay voided')`;
      paid += Number(bet.stake_cents);
      settled++;
      continue;
    }

    const combined = parlayOdds(live.map((l) => l.odds));
    const payout = payoutCents(Number(bet.stake_cents), combined);
    await sql`
      update bets set status = 'won', payout_cents = ${payout}, parlay_odds = ${combined},
                      settled_at = now()
      where id = ${bet.id}`;
    await sql`
      insert into ledger (bettor, amount_cents, reason, bet_id, note)
      values (${bet.bettor}, ${payout}, 'payout', ${bet.id},
              ${`${live.length}-leg parlay won`})`;
    paid += payout;
    settled++;
  }

  return { settled, paidCents: paid };
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

  // Parlay legs on this market resolve too, then any parlay whose legs are all
  // now decided gets paid or killed.
  const legStatus =
    winningOption === 'void' ? 'void' : winningOption === 'push' ? 'push' : null;
  if (legStatus) {
    await sql`
      update parlay_legs set status = ${legStatus}, settled_at = now()
      where market_id = ${marketId} and status = 'pending'`;
  } else {
    await sql`
      update parlay_legs
      set status = case when option_key = ${winningOption} then 'won' else 'lost' end,
          settled_at = now()
      where market_id = ${marketId} and status = 'pending'`;
  }

  await sql`
    update markets
    set status = ${winningOption === 'void' ? 'void' : 'settled'},
        winning_option = ${winningOption}, settled_at = now()
    where id = ${marketId}`;

  const parlays = await settleParlays();

  return { settled: bets.length, paidCents: paid + parlays.paidCents, parlays: parlays.settled };
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
 * The week's markets arranged by matchup.
 *
 * Every market carries a roster id in its meta -- h2h and spread carry both
 * sides, totals and props carry one -- so each can be attached to the game it
 * belongs to. That is what lets the board show five matchups instead of thirty
 * loose markets.
 */
export function groupByMatchup(markets) {
  // h2h defines the pairings; everything else attaches to whichever pairing
  // contains its roster.
  const games = [];
  for (const m of markets.filter((x) => x.kind === 'h2h')) {
    games.push({
      key: `${m.meta.homeRoster}-${m.meta.awayRoster}`,
      homeRoster: m.meta.homeRoster,
      awayRoster: m.meta.awayRoster,
      title: m.title,
      locksAt: m.locks_at,
      markets: { h2h: [m], spread: [], total: [], prop: [] },
    });
  }

  const rosterToGame = {};
  for (const g of games) {
    rosterToGame[g.homeRoster] = g;
    rosterToGame[g.awayRoster] = g;
  }

  for (const m of markets) {
    if (m.kind === 'h2h') continue;
    const roster = m.meta.rosterId ?? m.meta.homeRoster;
    const game = rosterToGame[roster];
    // A market whose roster is not in any pairing (a bye, or a stale market)
    // is dropped rather than silently attached to the wrong game.
    if (!game) continue;
    game.markets[m.kind]?.push(m);
  }

  for (const g of games) {
    // The matchup as a whole locks when its earliest market does.
    const all = Object.values(g.markets).flat();
    g.locksAt = all.reduce(
      (earliest, m) => (new Date(m.locks_at) < new Date(earliest) ? m.locks_at : earliest),
      g.locksAt,
    );
    g.marketCount = all.length;
  }

  return games.sort((a, b) => new Date(a.locksAt) - new Date(b.locksAt));
}

/**
 * Every settled bet in the league, newest first. Public by definition -- these
 * markets are long since locked, so there is nothing left to hide.
 */
export async function settledBets(season, limit = 200) {
  // LEFT joins, not inner: a parlay has no market_id or option_key, and an
  // inner join silently dropped every parlay from the results page.
  return sql`
    select b.id, b.bettor, b.option_key, b.stake_cents, b.odds, b.status,
           b.payout_cents, b.settled_at, b.is_parlay,
           m.title, m.subtitle, m.kind, m.week, m.winning_option,
           o.label as option_label, t.display_name as bettor_name,
           (select count(*)::int from parlay_legs pl where pl.bet_id = b.id) as leg_count
    from bets b
    left join markets m on m.id = b.market_id
    left join market_options o
      on o.market_id = b.market_id and o.option_key = b.option_key
    join bettors t on t.slug = b.bettor
    where b.status <> 'pending'
      and (m.season = ${season} or b.is_parlay = true)
    order by b.settled_at desc nulls last, b.id desc
    limit ${limit}`;
}

/** Legs for a set of parlays, so the UI can show what each one contained. */
export async function parlayLegsFor(betIds) {
  if (!betIds?.length) return {};
  const rows = await sql`
    select l.bet_id, l.option_key, l.odds, l.status, m.title, o.label as option_label
    from parlay_legs l
    join markets m on m.id = l.market_id
    join market_options o on o.market_id = l.market_id and o.option_key = l.option_key
    where l.bet_id = any(${betIds})
    order by l.bet_id, m.week, m.id`;
  const byBet = {};
  for (const r of rows) (byBet[r.bet_id] ??= []).push(r);
  return byBet;
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
    left join markets m on m.id = b.market_id
    join bettors t on t.slug = b.bettor
    where b.status <> 'pending'
      and (m.season = ${season} or b.is_parlay = true)
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
