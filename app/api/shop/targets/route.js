import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { currentManager } from '@/lib/auth';
import { byKind, TARGET, canAttach } from '@/lib/boosts';
import { currentWeek } from '@/lib/book';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

let _sql = null;
const sql = (...args) => {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql(...args);
};

/**
 * What a boost can legally be used on right now.
 *
 * This is what the picker shows, and it is deliberately computed on the server:
 * the list itself is sensitive. A boost that targets someone else's bet would
 * leak their position simply by naming it, so those kinds are NOT served here
 * -- they are the ones waiting on the visibility decision.
 *
 * Only two kinds need a picker today:
 *   - own-bet boosts list YOUR pending bets, which you can already see
 *   - market boosts list open markets, which everyone can already see
 */
export async function GET(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot use the store.' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const kind = searchParams.get('kind');
  const def = byKind[kind];
  if (!def) return NextResponse.json({ error: 'No such boost.' }, { status: 400 });

  // Anything aimed at somebody else's bet is used from The Action, where the
  // target is the row you tap -- stake and price visible, the pick withheld.
  // Listing those bets here would name them by market, which is the leak the
  // whole book is built to prevent.
  if (def.target === TARGET.BET) {
    return NextResponse.json({
      error: `${def.name} is used from The Action -- pick the bet there.`,
    }, { status: 400 });
  }

  if (def.target === TARGET.OWN_BET) {
    const rows = await sql`
      select b.id, b.stake_cents, b.odds, b.option_key, b.placed_at,
             m.id as market_id, m.title, m.kind, m.week, m.live, m.locks_at, m.status,
             o.label as option_label,
             b.is_parlay,
             (select count(*)::int from parlay_legs pl where pl.bet_id = b.id) as leg_count,
             (select count(*)::int from boosts bo
                where bo.target_bet_id = b.id and bo.kind = ${kind}) as already
      from bets b
      left join markets m on m.id = b.market_id
      left join market_options o on o.market_id = b.market_id and o.option_key = b.option_key
      where b.bettor = ${slug} and b.status = 'pending'
      order by b.placed_at desc`;

    // Cash Out shows its number before you commit: nobody should spend 18
    // points to find out what the bet was worth. One live fetch per week.
    const quotes = {};
    if (def.liveOnly) {
      const { liveMatchups, livePrice, stateForMarket } = await import('@/lib/live');
      const { impliedProbability, payoutCents } = await import('@/lib/odds');
      const byWeek = {};
      for (const r of rows) {
        if (r.is_parlay || !r.live || r.status !== 'open') continue;
        const [m] = await sql`
          select id, season, week, kind, meta from markets where id = ${r.market_id}`;
        if (!m) continue;
        try {
          byWeek[m.week] ??= await liveMatchups(m.season, m.week);
          const priced = livePrice(m, stateForMarket(m, byWeek[m.week].matchups));
          const odds = priced?.[r.option_key];
          if (odds != null) {
            quotes[r.id] = Math.round(
              payoutCents(Number(r.stake_cents), r.odds) * impliedProbability(odds),
            );
          }
        } catch {
          // No quote is shown; the server refuses the cash out on the same
          // grounds if it is tried.
        }
      }
    }

    const now = new Date();
    const targets = rows.map((r) => {
      const locked = r.locks_at ? new Date(r.locks_at) <= now : false;
      const check = canAttach(def, {
        marketLocked: locked,
        marketLive: Boolean(r.live),
        betStatus: 'pending',
      });
      // A parlay spans several markets, so "is it live" has no single answer.
      // Cash out is refused on one rather than guessing which leg to price.
      const isParlay = Boolean(r.is_parlay);

      // Undo works on anything unsettled, live or not, so it skips the
      // state checks the other own-bet boosts run.
      // Undo, Receipt and Mirror all work on any bet of yours regardless of
      // market state -- they void it, read it, or shield it, none of which
      // needs a price.
      const anyState = def.voids || def.reveals || def.reflects;
      // A cash out with no live quote is not on offer: the model has suspended
      // the market, so there is no number to settle at.
      const noQuote = def.liveOnly && quotes[r.id] == null;
      const eligible = anyState
        ? !r.already
        : check.ok && !r.already && !(def.liveOnly && isParlay) && !noQuote;

      let why = null;
      if (r.already) why = `Already has ${def.name}`;
      else if (anyState) why = null;
      else if (def.liveOnly && isParlay) why = 'Parlays cannot be cashed out';
      else if (!check.ok) why = check.why;
      else if (noQuote) why = 'No live price right now';

      return {
        id: String(r.id),
        title: isParlay ? `${r.leg_count}-leg parlay` : r.title,
        subtitle: isParlay ? null : r.option_label,
        stakeCents: Number(r.stake_cents),
        odds: r.odds,
        week: r.week,
        eligible,
        why,
        ...(quotes[r.id] != null ? { cashCents: quotes[r.id] } : {}),
      };
    });

    return NextResponse.json({ kind, target: 'bet', targets });
  }

  if (def.target === TARGET.MARKET) {
    const week = Number(searchParams.get('week') ?? (await currentWeek(SEASON)));

    // A week has well over a hundred open markets, most of them player props.
    // Handing all of them to a picker is not a choice, it is a scroll -- so the
    // list is limited to the markets a poisoning would actually be aimed at:
    // the matchup-level ones everybody bets. Props are excluded rather than
    // paginated, because poisoning one player prop is not a strategy.
    const rows = await sql`
      select m.id, m.title, m.subtitle, m.kind, m.locks_at, m.live, m.status,
             (select count(*)::int from boosts bo
                where bo.target_market_id = m.id and bo.kind = ${kind}) as already,
             (select count(*)::int from bets b where b.market_id = m.id) as bets
      from markets m
      where m.season = ${SEASON} and m.week = ${week} and m.status = 'open'
        and m.kind in ('h2h', 'spread', 'total', 'showdown', 'special')
      order by bets desc, m.kind, m.id`;

    const now = new Date();
    const targets = rows.map((r) => {
      const locked = new Date(r.locks_at) <= now && !r.live;
      const check = canAttach(def, { marketLocked: locked, marketLive: Boolean(r.live) });
      return {
        id: String(r.id),
        title: r.title,
        // How many people are already on it -- the only number that makes one
        // market worth poisoning over another, and it reveals no positions.
        subtitle: r.bets > 0 ? `${r.bets} bet${r.bets === 1 ? '' : 's'} placed` : r.subtitle,
        kind: r.kind,
        eligible: check.ok && !r.already,
        why: r.already ? 'Already poisoned' : check.ok ? null : check.why,
      };
    });

    return NextResponse.json({ kind, target: 'market', week, targets });
  }

  // Boosts aimed at a PERSON rather than a bet: Because, Fuck You and Slow
  // Play. This branch did not exist, so both returned an empty list and the
  // picker said "Nothing to use this on right now" -- with no way to fire a
  // 16-point boost somebody had already paid for.
  if (def.target === TARGET.BETTOR) {
    const week = Number(searchParams.get('week') ?? (await currentWeek(SEASON)));

    // Everyone but you. One of each kind may be live against a manager at a
    // time, so anybody already carrying this is listed but not selectable --
    // more use than hiding them, since it says why.
    const rows = await sql`
      select b.slug, b.display_name,
             (select count(*)::int from boosts bo
                where bo.target_bettor = b.slug and bo.kind = ${kind}
                  and bo.used_at is not null
                  and (bo.detail->>'week')::int = ${week}
                  and (${kind} <> 'slow-play' or bo.detail->>'spent' is null)) as already
      from bettors b
      where b.slug <> ${slug}
      order by b.display_name`;

    const targets = rows.map((r) => ({
      id: r.slug,
      title: r.display_name,
      subtitle: null,
      eligible: !r.already,
      why: r.already ? `Already has ${def.name} on them` : null,
    }));

    return NextResponse.json({ kind, target: 'bettor', week, targets });
  }

  return NextResponse.json({ kind, target: 'none', targets: [] });
}
