'use client';

import { useState } from 'react';

export default function Login({ bettors }) {
  const [slug, setSlug] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
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
      // Full reload rather than a router refresh: every page below this reads
      // the session cookie on the server, so they all need re-rendering.
      window.location.reload();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <p className="dim" style={{ marginBottom: 14 }}>
        Pick your name and enter the league password.
      </p>

      <select
        className="field"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        required
      >
        <option value="">Who are you?</option>
        {bettors.map((b) => (
          <option key={b.slug} value={b.slug}>
            {b.display_name}
          </option>
        ))}
      </select>

      <input
        className="field"
        type="password"
        placeholder="League password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        required
      />

      {error && <div className="form-error">{error}</div>}

      <button className="btn-primary" type="submit" disabled={busy || !slug}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
