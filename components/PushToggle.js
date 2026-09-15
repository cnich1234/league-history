'use client';

import { useEffect, useState } from 'react';

/**
 * "Turn on notifications", and the honest reasons it might not work.
 *
 * Android Chrome: works from the site or the installed app. iPhone: only
 * from the home-screen app, and only on iOS 16.4 or later, so a Safari tab
 * gets told to install first rather than a button that silently fails.
 */
const toKey = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export default function PushToggle() {
  const [state, setState] = useState('checking'); // checking | unsupported | install | off | on | denied | busy
  const [msg, setMsg] = useState(null);

  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = () =>
    window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setState(isIOS() && !standalone() ? 'install' : 'unsupported');
        return;
      }
      if (Notification.permission === 'denied') return setState('denied');
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sub = await reg.pushManager.getSubscription();
        setState(sub ? 'on' : 'off');
      } catch {
        setState('unsupported');
      }
    })();
  }, []);

  const turnOn = async () => {
    setState('busy');
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      const { key } = await fetch('/api/push/key').then((r) => r.json());
      if (!key) throw new Error('Notifications are not set up on the server yet.');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toKey(key),
      });
      const r = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Could not save this phone.');
      setState('on');
      setMsg({ ok: true, text: 'On. Sending you a test now.' });
      await fetch('/api/push/test', { method: 'POST' });
    } catch (e) {
      setState('off');
      setMsg({ ok: false, text: e.message });
    }
  };

  const turnOff = async () => {
    setState('busy');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState('off');
      setMsg(null);
    } catch (e) {
      setState('on');
      setMsg({ ok: false, text: e.message });
    }
  };

  const test = async () => {
    setMsg(null);
    const r = await fetch('/api/push/test', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? { ok: true, text: d.sent ? 'Sent. Check your phone.' : 'No device is registered for you.' } : { ok: false, text: d.error ?? 'Failed.' });
  };

  if (state === 'checking') return null;

  return (
    <div className="push-card">
      <div className="push-main">
        <div className="push-title">🔔 Phone notifications</div>
        <div className="push-sub">
          {state === 'on' && 'On for this phone. Attacks, bounties, fills and payouts will buzz you.'}
          {state === 'off' && 'Get buzzed when someone attacks your bet, posts a bounty on you, or your Market order fills.'}
          {state === 'busy' && 'One moment…'}
          {state === 'denied' && 'Blocked in your phone settings for this site. Allow notifications there, then come back.'}
          {state === 'install' && 'On iPhone, notifications only work from the home-screen app: tap Share, then "Add to Home Screen", and open it from there.'}
          {state === 'unsupported' && 'This browser cannot receive push notifications.'}
        </div>
        {msg && <div className={`push-msg ${msg.ok ? 'push-ok' : 'push-bad'}`}>{msg.text}</div>}
      </div>
      <div className="push-actions">
        {state === 'off' && (
          <button type="button" className="push-btn" onClick={turnOn}>
            Turn on
          </button>
        )}
        {state === 'on' && (
          <>
            <button type="button" className="push-btn push-ghost" onClick={test}>
              Send test
            </button>
            <button type="button" className="push-btn push-ghost" onClick={turnOff}>
              Turn off
            </button>
          </>
        )}
      </div>
    </div>
  );
}
