import { NextResponse } from 'next/server';
import { currentManager } from '@/lib/auth';
import {
  buyBoost,
  useBoostOnBet,
  useBoostOnMarket,
  useBoostOnWeek,
  armBoost,
} from '@/lib/shop';

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
      const boostId = Number(body.boostId);
      if (!Number.isFinite(boostId)) {
        return NextResponse.json({ error: 'Which boost?' }, { status: 400 });
      }

      if (body.betId != null) {
        const row = await useBoostOnBet({ slug, boostId, betId: Number(body.betId) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }
      if (body.marketId != null) {
        const row = await useBoostOnMarket({ slug, boostId, marketId: Number(body.marketId) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }
      if (body.week != null) {
        const row = await useBoostOnWeek({ slug, boostId, week: Number(body.week) });
        return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
      }

      // No target at all. Better Price arms and is consumed by whatever is bet
      // next, so "using" it is just marking it ready -- there is nothing to
      // point it at.
      const row = await armBoost({ slug, boostId });
      return NextResponse.json({ ok: true, used: { ...row, id: String(row.id) } });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    // The message is the point -- these are all rules a person broke, and each
    // one is written to be read by them rather than by a log.
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
