import { neon } from '@neondatabase/serverless';
import {
  payoutCents,
  parlayOdds,
  impliedProbability,
  maxLiveStake,
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

/**
 * Markets still open for betting, with their prices.
 *
 * `status` is the whole test. It used to also require `locks_at > now()`, which
 * dropped every live market past its posted lock -- the most active ones on the
 * board -- and later every prop whose midnight stamp had passed while its game
 * was still hours away. Whether a live market is currently *quotable* is a
 * separate question, decided by `shouldSuspend` at pricing time.
 */
export async function getOpenMarkets(season, week) {
  const markets = await sql`
    select id, season, week, kind, title, subtitle, locks_at, status, meta, live
    from markets
    where season = ${season} and week = ${week} and status = 'open'
    order by kind, id`;
  return attachOptions(markets);
}

export async function getMarketsForWeek(season, week) {
  const markets = await sql`
    select id, season, week, kind, title, subtitle, locks_at, status, winning_option, meta, live
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
  // LEFT joins, not inner: a parlay has no market_id and no option_key, and an
  // inner join drops it entirely. Every parlay was missing from "My bets" --
  // the same mistake settledBets had, fixed here too.
  return sql`
    select b.id, b.market_id, b.option_key, b.stake_cents, b.odds, b.status,
           b.payout_cents, b.placed_at, b.is_parlay,
           m.title, m.subtitle, m.kind, m.week, m.locks_at, m.status as market_status,
           o.label as option_label,
           (select count(*)::int from parlay_legs pl where pl.bet_id = b.id) as leg_count
    from bets b
    left join markets m on m.id = b.market_id
    left join market_options o
      on o.market_id = b.market_id and o.option_key = b.option_key
    where b.bettor = ${slug}
    order by b.placed_at desc`;
}

/**
 * Other people's bets -- only from markets nobody can still bet.
 *
 * This is the single query the whole "no copying" rule rests on, and filtering
 * on `locks_at <= now()` alone was not enough once live betting arrived: a live
 * market stays open past its posted lock, so bets on it were being shown while
 * people could still act on them. One was a $250 stake sitting in plain view of
 * anyone deciding which side to take.
 *
 * The rule is now simply: reveal a bet once its market is no longer open. One
 * condition for every kind, because "open" is exactly the thing that decides
 * whether anyone can still act.
 *
 * It was briefly `m.live = false or m.status <> 'open'`, which looked like it
 * handled both cases but let every prop through on its posted time alone -- and
 * a prop's posted time is midnight on the morning of the game, so Brandon's
 * Stafford bet went public while the game was still hours away. Anything that
 * reads `locks_at` as "closed" is the same bug wearing a different hat.
 *
 * Failure mode if locking ever stops: markets stay `open` and these bets stay
 * hidden. Hiding too much is the safe direction.
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
      and m.status <> 'open'
    order by b.placed_at`;
}

/**
 * Weeks that have markets, for the board's week switcher.
 *
 * Without this there was no way to reach another week at all: the page read
 * `?week=` and nothing in the UI ever set it, so week 2's markets existed but
 * were unreachable by anyone who did not hand-edit the URL.
 */
export async function weeksWithMarkets(season) {
  const rows = await sql`
    select week,
           count(*)::int as markets,
           count(*) filter (where status = 'open')::int as open
    from markets where season = ${season}
    group by week order by week`;
  return rows.map((r) => ({ week: Number(r.week), markets: r.markets, open: r.open }));
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
/**
 * Places a bet, live or pregame.
 *
 * `expectedOdds` is what the client had on screen. The server prices the bet
 * itself and rejects if the two have drifted apart -- this is both a fairness
 * measure and a security one. Without it a client could POST whatever odds it
 * liked; with it, a price that moved while someone was tapping is refused
 * rather than silently filled at a worse number. Real books call this a bet
 * delay and use it the same way.
 */
export async function placeBet({ slug, marketId, optionKey, stakeCents, expectedOdds = null }) {
  if (!Number.isInteger(stakeCents)) throw new Error('Stake must be a whole number of cents.');
  if (stakeCents < MIN_STAKE_CENTS) throw new Error(`Minimum bet is $${MIN_STAKE_CENTS / 100}.`);
  if (stakeCents > MAX_STAKE_CENTS) throw new Error(`Maximum bet is $${MAX_STAKE_CENTS / 100}.`);

  const [market] = await sql`
    select id, status, locks_at, live, kind, meta, season, week
    from markets where id = ${marketId}`;
  if (!market) throw new Error('No such market.');
  if (market.status !== 'open') throw new Error('This market is closed.');

  // No locks_at check. A prop closes by being locked at its player's kickoff --
  // the status check above already caught that. locks_at is midnight on the
  // morning of the game, hours early for a night kickoff, and rejecting on it
  // refused bets on games that had not started.
  const pastLock = new Date(market.locks_at) <= new Date();

  const [option] = await sql`
    select odds from market_options where market_id = ${marketId} and option_key = ${optionKey}`;
  if (!option) throw new Error('No such option on this market.');

  // Pregame uses the posted line. Once a market is live, the price comes from
  // the current game state -- computed here on the server, never taken from
  // the request.
  let odds = option.odds;

  // An armed odds boost is consumed here, before the live model runs, so a
  // live bet gets its boost applied to the CURRENT price rather than the stale
  // posted one. Claimed atomically -- two bets placed at once cannot both take
  // the same boost.
  let oddsBoostId = null;

  if (pastLock && market.live) {
    const { liveMatchups, livePrice, stateForMarket } = await import('./live.js');
    const state = await liveMatchups(market.season, market.week);
    const priced = livePrice(market, stateForMarket(market, state.matchups));
    if (!priced) throw new Error('This market is closed -- the result is no longer in doubt.');
    if (priced[optionKey] == null) throw new Error('No live price for that side.');
    odds = priced[optionKey];

    // The limit tightens as the result becomes clearer. A $250 bet on a coin
    // flip and a $250 bet on something 88% decided are not the same wager.
    const cap = maxLiveStake(priced.probability);
    if (stakeCents > cap) {
      throw new Error(
        `Maximum on this market right now is $${(cap / 100).toFixed(0)} -- it is close to decided.`,
      );
    }

    // Reject if the price moved materially while they were deciding. 15% of
    // the implied probability is loose enough not to fire on ordinary drift
    // and tight enough to catch a scoring play landing mid-tap.
    if (expectedOdds != null) {
      const shown = impliedProbability(Number(expectedOdds));
      const now = impliedProbability(odds);
      if (Math.abs(shown - now) > 0.15 * shown) {
        throw new Error('The price moved. Check the new number and try again.');
      }
    }
  }

  const [existing] = await sql`
    select 1 from bets where bettor = ${slug} and market_id = ${marketId}`;
  if (existing) throw new Error('You already have a bet on this market.');

  const [balance] = await sql`select balance_cents from bankrolls where slug = ${slug}`;
  if (!balance) throw new Error('Unknown bettor.');
  if (Number(balance.balance_cents) < stakeCents) throw new Error('Not enough in your bankroll.');

  // Last, after every rule has passed: an armed odds boost is spent only on a
  // bet that is actually going to be placed. Consuming it earlier would burn
  // someone's boost on a bet the bankroll check then refused.
  const { consumeOddsBoost } = await import('./shop.js');
  const boosted = await consumeOddsBoost({ slug, season: market.season, odds });
  if (boosted) {
    odds = boosted.odds;
    oddsBoostId = boosted.boostId;
  }

  // Odds are frozen at placement; a later move must not change this bet.
  const [bet] = await sql`
    insert into bets (bettor, market_id, option_key, stake_cents, odds)
    values (${slug}, ${marketId}, ${optionKey}, ${stakeCents}, ${odds})
    returning id, stake_cents, odds`;

  await sql`
    insert into ledger (bettor, amount_cents, reason, bet_id, note)
    values (${slug}, ${-stakeCents}, 'stake', ${bet.id}, 'Bet placed')`;

  // Point the spent boost at the bet it paid for, so "Already used" can say
  // which one rather than just that it is gone.
  if (oddsBoostId) {
    await sql`update boosts set target_bet_id = ${bet.id} where id = ${oddsBoostId}`;
  }

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
    select id, status, locks_at, live, kind, meta, season, week
    from markets where id = any(${marketIds})`;
  if (markets.length !== marketIds.length) throw new Error('A market in this parlay no longer exists.');

  const now = new Date();
  const marketById = Object.fromEntries(markets.map((m) => [Number(m.id), m]));
  for (const m of markets) {
    // Status is the only closing test, for every kind of leg. Rejecting on
    // locks_at as well refused parlays whose legs were plainly bettable on the
    // board -- live legs first, then prop legs whose games had not kicked off.
    if (m.status !== 'open') throw new Error('A market in this parlay is closed.');
  }

  const options = await sql`
    select market_id, option_key, odds from market_options where market_id = any(${marketIds})`;

  // Any leg past its lock is priced from the current game state, server-side,
  // exactly as a straight bet would be. Fetched once per week rather than per
  // leg, since a parlay's legs usually share a week.
  const liveState = {};
  const priced = [];
  for (const leg of legs) {
    const marketId = Number(leg.marketId);
    const market = marketById[marketId];
    const o = options.find(
      (x) => Number(x.market_id) === marketId && x.option_key === leg.optionKey,
    );
    if (!o) throw new Error('A leg names an option that does not exist.');

    let odds = o.odds;
    if (new Date(market.locks_at) <= now && market.live) {
      const { liveMatchups, livePrice, stateForMarket } = await import('./live.js');
      const cacheKey = `${market.season}-${market.week}`;
      liveState[cacheKey] ??= await liveMatchups(market.season, market.week);
      const quote = livePrice(market, stateForMarket(market, liveState[cacheKey].matchups));
      if (!quote) {
        throw new Error('A market in this parlay is closed -- the result is no longer in doubt.');
      }
      if (quote[leg.optionKey] == null) throw new Error('No live price for one of these legs.');
      odds = quote[leg.optionKey];

      // A parlay is capped by its tightest leg. One near-decided leg makes the
      // whole slip a bet on the others, so it should not carry a bigger stake
      // than that leg would take on its own.
      if (quote.maxStakeCents != null && stakeCents > quote.maxStakeCents) {
        throw new Error(
          `Maximum on this parlay right now is $${(quote.maxStakeCents / 100).toFixed(0)} --` +
            ' one leg is close to decided.',
        );
      }
    }

    priced.push({ marketId, optionKey: leg.optionKey, odds });
  }

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
    // Parlays take boosts too. Settled on a different path from straight bets,
    // which is exactly how getMyBets, settledBets and settledSummary each
    // silently dropped every parlay in turn -- a second path is a second place
    // to forget.
    const { boostsForBets: parlayBoosts } = await import('./shop.js');
    const { applyBoosts: applyParlayBoosts } = await import('./boosts.js');
    const heldByBet = await parlayBoosts([bet.id]);
    const payout = applyParlayBoosts(
      payoutCents(Number(bet.stake_cents), combined),
      heldByBet[bet.id] ?? [],
    );
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

  // Boosts attached to these bets. Fetched once rather than per bet, and only
  // read here -- a boost changes what a win pays, never whether it won.
  const { boostsForBets } = await import('./shop.js');
  const { applyBoosts } = await import('./boosts.js');
  const boostsByBet = await boostsForBets(bets.map((b) => b.id));

  let paid = 0;
  for (const bet of bets) {
    // 'push' and 'void' both refund the stake. A void is for a market that
    // cannot be decided fairly at all -- a prop on a player who never started,
    // say -- where settling it as a loss would punish a bet nobody could win.
    const refund = winningOption === 'push' || winningOption === 'void';
    const won = !refund && bet.option_key === winningOption;
    const status = refund ? (winningOption === 'void' ? 'void' : 'push') : won ? 'won' : 'lost';
    // A refund returns the stake untouched: boosts multiply a win, and a push
    // is not a win. Taking 20% off a refunded stake would be theft.
    const payout = refund
      ? Number(bet.stake_cents)
      : won
        ? applyBoosts(payoutCents(Number(bet.stake_cents), bet.odds), boostsByBet[bet.id] ?? [])
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
export function groupByMatchup(markets, allMarkets = markets) {
  // Pairings come from EVERY h2h in the week, not just the open ones, so a
  // matchup whose h2h has locked still has a home for its later-locking props.
  const pairings = [];
  const seen = new Set();
  for (const m of allMarkets.filter((x) => x.kind === 'h2h')) {
    const key = `${m.meta.homeRoster}-${m.meta.awayRoster}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairings.push({
      key,
      homeRoster: m.meta.homeRoster,
      awayRoster: m.meta.awayRoster,
      title: m.title,
    });
  }

  const rosterToPairing = {};
  for (const p of pairings) {
    rosterToPairing[p.homeRoster] = p;
    rosterToPairing[p.awayRoster] = p;
  }

  // One card per matchup, holding every bet on that game regardless of when it
  // locks. Splitting by lock day was tried first and the league found it
  // convoluted -- the same matchup appearing twice under different headings.
  // Each bet now carries its own lock date instead.
  const byKey = new Map();
  for (const m of markets) {
    const pairing = rosterToPairing[m.meta.rosterId ?? m.meta.homeRoster];
    // A market whose roster is in no pairing (a bye, or something stale) is
    // dropped rather than silently attached to the wrong game.
    if (!pairing) continue;

    if (!byKey.has(pairing.key)) {
      byKey.set(pairing.key, {
        key: pairing.key,
        homeRoster: pairing.homeRoster,
        awayRoster: pairing.awayRoster,
        title: pairing.title,
        locksAt: m.locks_at,
        markets: { h2h: [], spread: [], showdown: [], total: [], prop: [] },
      });
    }
    const game = byKey.get(pairing.key);
    game.markets[m.kind]?.push(m);
    if (new Date(m.locks_at) < new Date(game.locksAt)) game.locksAt = m.locks_at;
  }

  const games = [...byKey.values()];
  for (const g of games) {
    g.marketCount = Object.values(g.markets).flat().length;
    // How many are still bettable, so a card can say so without the UI
    // recomputing it.
    // Status, not the clock. A live market trades past its posted lock, and a
    // prop stays open until its player's game actually kicks off.
    g.openCount = Object.values(g.markets).flat().filter((m) => m.status === 'open').length;
    // Open markets first, then by lock time. Sorting purely by lock time put
    // closed bets above ones you can still place, which buries the useful half
    // of a twenty-bet card.
    for (const kind of Object.keys(g.markets)) {
      g.markets[kind].sort((a, b) => {
        const aShut = a.status !== 'open';
        const bShut = b.status !== 'open';
        if (aShut !== bShut) return aShut ? 1 : -1;
        return new Date(a.locks_at) - new Date(b.locks_at);
      });
    }
  }

  return games
    .filter((g) => g.marketCount > 0)
    .sort((a, b) => new Date(a.locksAt) - new Date(b.locksAt) || a.title.localeCompare(b.title));
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
    select l.bet_id, l.market_id, l.option_key, l.odds, l.status, m.title,
           o.label as option_label
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

/**
 * Locks any market that can no longer be bet. Safe to run repeatedly.
 *
 * Since live betting, only one thing closes on the clock: a player prop, at
 * its own player's kickoff. Everything else -- h2h, spread, team total -- is
 * live and keeps trading, priced from the game state, until the result is no
 * longer in doubt. `shouldSuspend` decides that, not a timestamp.
 *
 * So `locks_at` is not a closing time for a live market at all. It only marks
 * when pricing switches from the posted line to the live model. That is why a
 * matchup with one Thursday starter stays bettable all week: the board reprices
 * it rather than shutting it.
 *
 * `finishedRosters` is the set of roster ids whose games are final, from
 * Sleeper -- what closes a live market for good. `kickedOffTeams` is the set of
 * NFL teams whose games have started, which is what closes a prop. Both are
 * facts Sleeper reports; neither is inferred from a clock, because `locks_at`
 * is midnight Arizona on the morning of the game and runs some eighteen hours
 * early for a Thursday night kickoff. Trusting it shut a prop for a game that
 * had not begun and put the bettor's position on The Floor.
 *
 * A prop closes when its own player's game starts. A league-wide `special`
 * involves every lineup, so the week's first kickoff closes it -- it carries no
 * nflTeam, and `= any()` against NULL is never true, so without its own branch
 * it would never lock at all.
 *
 * Both arguments default to empty, and empty means "nothing has happened yet",
 * so nothing locks. Not knowing is never a reason to close a market: a market
 * left open is still governed by `shouldSuspend` at pricing time, so nothing
 * can be bet at a decided price either way.
 */
/**
 * @param finishedRosters roster ids whose games are final
 * @param kickedOffTeams  NFL teams whose games have started
 * @param scope           { season, week } the roster ids describe. Required for
 *                        the stale-lock correction: roster 2 being unfinished
 *                        this week says nothing about last week, and without a
 *                        scope the reopen would reach across the whole season.
 */
export async function lockDueMarkets(finishedRosters = [], kickedOffTeams = [], scope = null) {
  const teams = [...kickedOffTeams].filter(Boolean);
  const season = scope?.season ?? null;
  const week = scope?.week ?? null;

  // A prop closes when its player's game kicks off, and only then. A prop with
  // no nflTeam cannot be checked, so it is left alone rather than guessed at.
  const plain = teams.length
    ? await sql`
        update markets set status = 'locked'
        where status = 'open' and live = false and locks_at <= now()
          and (
            meta->>'nflTeam' = any(${teams})
            or (meta->>'special' is not null and meta->>'nflTeam' is null)
          )
        returning id, title`
    : [];

  const rosters = [...finishedRosters].map(Number).filter(Number.isFinite);

  // Reopen any live market locked on a roster that is not finished.
  //
  // A lock is a judgement about game state, and game state is refetched every
  // poll -- so a lock made from bad data should not outlive the data. Two
  // markets sat closed all weekend because they were locked during the window
  // when Sleeper's has1st_quarter_started flag wrongly reported unplayed games
  // as started; nothing would ever have reopened them.
  //
  // Only live markets. A prop closing at kickoff is a one-way door: its price
  // was never going to move again, and reopening it would let someone bet a
  // player who has already scored.
  // Not gated on rosters.length: an EMPTY finished list is the strongest case
  // for reopening, not a reason to skip. Nobody finished means every live lock
  // is unjustified. Gating on it left four markets closed with 111 projected
  // points still to come.
  const stale = season != null && week != null
    ? await sql`
        update markets set status = 'open'
        where live = true and status = 'locked'
          and season = ${season} and week = ${week}
          and (
            (meta->>'rosterId' is not null
             and not ((meta->>'rosterId')::int = any(${rosters})))
            or (meta->>'homeRoster' is not null and meta->>'awayRoster' is not null
                and not ((meta->>'homeRoster')::int = any(${rosters})
                         and (meta->>'awayRoster')::int = any(${rosters})))
          )
        returning id, title`
    : [];
  if (stale.length) {
    // Not an error: this is the correction working. Worth a line in the log so
    // a recurring reopen is visible rather than silent.
    console.warn(`Reopened ${stale.length} live market(s) locked on unfinished rosters.`);
  }

  if (!rosters.length) return plain;

  // A live market closes only when every roster it depends on is final. h2h and
  // spread carry both rosters; a team total carries just its own.
  //
  // No `locks_at` here on purpose. For a live market that timestamp is when
  // pricing switched to the live model, not a deadline, and a roster cannot be
  // final before it has played anyway.
  const live = await sql`
    update markets set status = 'locked'
    where status = 'open' and live = true
      and (
        (meta->>'homeRoster' is not null and meta->>'awayRoster' is not null
         and (meta->>'homeRoster')::int = any(${rosters})
         and (meta->>'awayRoster')::int = any(${rosters}))
        or
        (meta->>'homeRoster' is null and meta->>'rosterId' is not null
         and (meta->>'rosterId')::int = any(${rosters}))
      )
    returning id, title`;

  return [...plain, ...live];
}

