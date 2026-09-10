'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Buys one boost.
 *
 * Deliberately not a confirm-then-buy flow like BetSlip: a boost costs points
 * rather than money, and buying one is reversible in the sense that it sits in
 * your inventory until you choose a target. The irreversible step is USING it,
 * which is where the confirmation lives.
 */
export default function BuyButton({ kind, cost, points }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const afford = points >= cost;

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'buy', kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not buy that.');
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="shop-buy" type="button" onClick={buy} disabled={busy || !afford}>
        {busy ? 'Buying…' : afford ? 'Buy' : `Need ${cost - points} more`}
      </button>
      {error && <div className="form-error">{error}</div>}
    </>
  );
}
