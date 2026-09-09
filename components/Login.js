'use client';

import { useState } from 'react';

/**
 * Sign in, or claim your account if this is the first time.
 *
 * One flow rather than separate "register" and "log in" screens: with ten
 * people who each do this once, a second button is only an opportunity to press
 * the wrong one. The form tells you which is happening based on whether that
 * name has been claimed yet.
 */
export default function Login({ bettors }) {
  const [slug, setSlug] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const selected = bettors.find((b) => b.slug === slug);
  const isNew = selected && !selected.has_password;
  const mismatch = isNew && confirm.length > 0 && password !== confirm;

  async function submit(e) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not sign in.');
      // Full reload: every page below reads the session cookie on the server.
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <select className="field" value={slug} onChange={(e) => setSlug(e.target.value)} required>
        <option value="">Who are you?</option>
        {bettors.map((b) => (
          <option key={b.slug} value={b.slug}>
            {b.display_name}
            {b.has_password ? '' : ' — not set up yet'}
          </option>
        ))}
      </select>

      {isNew && (
        <p className="claim-note">
          First time in. Pick a password only you know — it is how the others are kept out of
          your bets.
        </p>
      )}

      <input
        className="field"
        type="password"
        placeholder={isNew ? 'Choose a password' : 'Your password'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={isNew ? 'new-password' : 'current-password'}
        minLength={6}
        required
      />

      {isNew && (
        <input
          className="field"
          type="password"
          placeholder="Type it again"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      )}

      {mismatch && <div className="form-error">Those do not match.</div>}
      {error && <div className="form-error">{error}</div>}

      <button className="btn-primary" type="submit" disabled={busy || !slug || mismatch}>
        {busy ? 'Working…' : isNew ? 'Claim my account' : 'Sign in'}
      </button>

      <p className="dim" style={{ fontSize: 12, marginTop: 4 }}>
        Forgot yours? Ask Chris to reset it.
      </p>
    </form>
  );
}
