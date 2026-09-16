# Phone notifications

Web push, no third party. The app signs each push with its own VAPID key
pair (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Vercel and
`.env.local`) and the phone's browser vendor delivers it.

**Where it works.** Android Chrome, from the site or the installed app.
iPhone only from the home-screen app (Share, Add to Home Screen) on iOS 16.4
or later; a Safari tab is told to install first.

**Turning it on.** The card at the top of The Book. It registers
`public/sw.js`, asks permission, subscribes, saves the subscription to
`push_subscriptions` (one row per device, migration 028) and sends a test.
Turn off removes the row and unsubscribes the phone.

**What buzzes you** (`lib/push.js`)

| Event | Where it fires | Who |
|---|---|---|
| A bet of yours is attacked (any attack boost, Switcheroo) | `app/api/shop/route.js` | the bet's owner, attacker not named |
| A bounty is posted on you | `app/api/bounty/route.js` | the target |
| A bounty is posted, generic and snarky, no name | `app/api/bounty/route.js` | everyone else with a device |
| A Market order fills or is rejected | `lib/market/trading.js` `fillOrders` | the owner |
| Dividends paid at the roll | `lib/market/trading.js` `payDividends` | each owner paid |
| Week settled, trophies and allowance paid | `app/api/cron/route.js`, only on the run that paid | everyone with a device |

Slow Play is deliberately silent: the rules say you find out when you go to
bet. Every send is best effort and awaited inside the request so the
serverless function does not exit first; a dead subscription (404/410 from
the push service) is deleted, any other failure is logged and swallowed.

**Testing.** `POST /api/push/test` sends the signed-in manager a test. There
is no automated test: it needs a real phone. The routes refuse guests.

## Tests never reach a phone

Every suite runs against the live database with real bettor slugs, which is
what keeps them honest. But `notify` takes a slug, not a season, so a sentinel
fill in season 9985 sent "✅ Bought 2 × p1 at 12" to Chris's lock screen three
times on 2026-09-16 -- once per `npm run test:markettrade`.

`lib/push.js` now refuses to send from a test run. The guard is in `notify`,
which `notifyMany` and `notifyAll` both funnel through, so one check covers
every send in the app. It fires on `PUSH_SILENT=1` or on an entrypoint matching
`*.test.mjs`, which catches a suite run directly with `node` as well as through
npm. `npm run test:pushguard` asserts all three senders stay silent.

The guard is here rather than in the twenty-two suites that can reach a
notification, because one place that cannot be forgotten beats twenty-two that
can.
