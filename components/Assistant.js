'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A chat button that follows you around the app.
 *
 * Fixed to the bottom right on every page, above the tab bar. Closed it is a
 * circle; open it is a small panel. Deliberately not a route -- the question is
 * usually about whatever is on screen, and making somebody navigate away to ask
 * it loses the thing they were looking at.
 */
export default function Assistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  // Follow the conversation down as it grows.
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, open, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes it, which is what everybody tries first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function send(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;

    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'That did not work.');
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setError(err.message);
      // Put the question back rather than losing it to a failed request.
      setMessages((m) => m.slice(0, -1));
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="assistant-fab"
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask about the app"
      >
        <ClaudeMark />
      </button>
    );
  }

  return (
    <div className="assistant-panel" role="dialog" aria-label="Assistant">
      <div className="assistant-head">
        <span className="assistant-head-mark">
          <ClaudeMark />
        </span>
        <span className="assistant-title">Ask about The Book</span>
        <button
          type="button"
          className="assistant-close"
          onClick={() => setOpen(false)}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="assistant-log">
        {messages.length === 0 && (
          <div className="assistant-hint">
            Rules, prices, what is on the board, how a boost works. It can see this
            week&apos;s markets and everybody&apos;s points — but not who backed what.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`assistant-msg assistant-msg-${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="assistant-msg assistant-msg-assistant dim">Thinking…</div>}
        {error && <div className="form-error">{error}</div>}
        <div ref={endRef} />
      </div>

      <form className="assistant-ask" onSubmit={send}>
        <input
          ref={inputRef}
          className="field"
          value={draft}
          placeholder="Ask something…"
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
        <button className="btn-primary btn-sm" type="submit" disabled={busy || !draft.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

/** The Claude mark, inline so it needs no asset and inherits colour. */
function ClaudeMark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6.7 15.6 11 13.2l.07-.2-.07-.11h-.2l-.7-.05-2.4-.06-2.06-.09-2-.11-.5-.11L3 12.03l.05-.31.42-.28.6.05 1.33.09 2 .14 1.45.08 2.14.23h.34l.05-.14-.12-.08-.09-.09-2.1-1.42-2.27-1.5-1.19-.87-.64-.44-.33-.41-.14-.9.59-.65.79.05.2.06.8.61 1.71 1.33 2.24 1.65.32.27.13-.09.02-.07-.15-.24L10.15 7l-1.3-2.25-.58-.93-.15-.56a2.7 2.7 0 0 1-.1-.66l.68-.91L9.08 2l.9.13.38.33.56 1.28.9 2.02 1.42 2.76.41.82.22.76.09.23h.14v-.13l.12-1.55.22-1.9.2-2.44.08-.69.33-.8.66-.43.51.25.42.6-.06.39-.25 1.63-.5 2.57-.32 1.72h.19l.21-.21.86-1.14 1.44-1.8.64-.72.74-.79.48-.38h.9l.66.98-.3 1.01-.92 1.17-.77 1L18 10.2l-.32.56.03.05.77-.08 1.16-.16 1.42-.24.6-.16.72.34.08.34-.28.7-1.7.42-2 .4-2.96.7-.04.03.04.04 1.34.13.57.03h1.4l2.6.2.68.44.4.55-.07.42-1.05.53-1.4-.33-3.28-.78-1.12-.28h-.16v.1l.94.91 1.71 1.55 2.15 2 .1.5-.27.39-.29-.04-1.88-1.41-.72-.64-1.64-1.38h-.11v.15l.38.55 2 3 .1.93-.14.3-.52.18-.57-.1-1.17-1.65-1.21-1.86-.98-1.66-.12.07-.58 6.19-.27.32-.62.24-.52-.4-.28-.63.28-1.27.33-1.65.27-1.31.24-1.63.15-.54-.01-.04h-.12l-1.22 1.68L8.86 21l-1.4 1.5-.34.13-.58-.3.06-.54.32-.48 1.94-2.46 1.17-1.53.75-.88-.01-.13h-.05L4.4 19.9l-1.02.13-.44-.41.05-.67.21-.22 1.73-1.19z"
      />
    </svg>
  );
}
