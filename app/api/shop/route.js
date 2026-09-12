import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import {
  buyBoost,
  useBoostOnBet,
  useBoostOnMarket,
  useBoostOnWeek,
  rideAlong,
  curseWeek,
  undoBet,
  readReceipt,
  switcheroo,
  slowPlay,
  openHedge,
  rideAlong as ride,
  cashOut,
  lockInPrice,
} from '@/lib/shop';
import { currentWeek } from '@/lib/book';

export const dynamic = 'force-dynamic';

const SEASON = Number(process.env.BOOK_SEASON ?? 2026);

/**
 * Buying and using boosts.
 *
 * currentManager, not currentBettor: a guest is signed in but owns no points
 * and no bets, so it must not reach any of this. Every other rule -- can you
 * afford it, is it yours, is that a legal target -- is enforced in lib/shop.js
 * against the database, because a check in a component is a suggestion.
 */
export async function POST(request) {
  const slug = await currentManager();
  if (!slug) {
    return NextResponse.json({ error: 'Guests cannot use the store.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));

  try {
    if (body.action === 'buy') {
      const boost = await buyBoost({ slug, season: SEASON, kind: body.kind });
      return NextResponse.json({ ok: true, boost: { ...boost, id: String(boost.id) } });
    }

    if (body.action === 'use') {
      const { byKind } = await import('@/lib/boosts');
      const boostId = Number(body.boostId);
      if (!Number.isFinite(boostId)) {
        return NextResponse.json({ error: 'Which boost?' }, { status: 400 });
      }

      if (body.betId != null) {
        // Ride Along creates a bet rather than modifying one, so it has its own
        // path -- routing it through useBoostOnBet would have treated a copy as
        // an attack on the thing it copied.
        // Switcheroo moves a bet rather than modifying its payout.
        if (byKind[body.kind]?.flips || body.switch) {
          const row = await switcheroo({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, switched: row });
        }
        // Receipt reads rather than writes: it returns WHO, and changes no money.
        if (byKind[body.kind]?.reveals || body.receipt) {
          const found = await readReceipt({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, attackers: found });
        }
        // Undo voids a bet rather than modifying one, so it has its own path.
        if (byKind[body.kind]?.voids || body.undo) {
          const row = await undoBet({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, undone: row });
        }
        if (byKind[body.kind]?.copies || body.copy) {
          const row = await ride({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, copied: row });
        }
        // Hedge opens a second slot on the bet's market rather than attaching
        // to the bet. It fell through to useBoostOnBet, which marked the boost
        // used and opened nothing -- 24 points for a "you already have a bet
        // on this market" on the very next tap.
        if (byKind[body.kind]?.hedges || body.hedge) {
          const row = await openHedge({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, hedged: row });
        }
        // Cash Out settles the bet now. Like Hedge it fell through to
        // useBoostOnBet, which spent the boost and settled nothing.
        if (byKind[body.kind]?.liveOnly || body.cashout) {
          const row = await cashOut({ slug, boostId, betId: Number(body.betId) });
          return NextResponse.json({ ok: true, cashed: row });
        }
        const row = await useBoostOnBet({ slug, boostId, betId: Number(body.betId) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }
      if (body.target != null && byKind[body.kind]?.doublesStake) {
        const row = await slowPlay({
          slug,
          boostId,
          target: String(body.target),
          week: Number(body.week ?? (await currentWeek(SEASON))),
        });
        return NextResponse.json({ ok: true, slowed: row });
      }
      if (body.target != null) {
        const row = await curseWeek({
          slug,
          boostId,
          target: String(body.target),
          week: Number(body.week ?? (await currentWeek(SEASON))),
        });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }
      if (body.marketId != null && (byKind[body.kind]?.locksPrice || body.optionKey != null)) {
        // Lock In freezes one side's price. useBoostOnMarket wrote no side and
        // no expiry, so the lock existed as a used boost and nothing else.
        const row = await lockInPrice({
          slug,
          boostId,
          marketId: Number(body.marketId),
          optionKey: String(body.optionKey ?? ''),
        });
        return NextResponse.json({ ok: true, locked: row });
      }
      if (body.marketId != null) {
        const row = await useBoostOnMarket({ slug, boostId, marketId: Number(body.marketId) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }
      if (body.week != null) {
        // Ghost and Big Week both attach to a week with nothing to point at.
        const row = await useBoostOnWeek({ slug, boostId, week: Number(body.week) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }

      return NextResponse.json(
        { error: 'Pick something to use it on.' },
        { status: 400 },
      );
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    // The message is the point -- these are all rules a person broke, and each
    // one is written to be read by them rather than by a log.
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
