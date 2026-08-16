# League History

A mobile-first web app for the ESPN fantasy league **League of Extraordinary
Gentlemen** (league `264063`) — all-time records, championships, and
head-to-head.

Covers all 18 seasons, 2008–2025.

Built with Next.js as a fully static export, so it deploys free on Vercel with no
server, no serverless functions, and no runtime dependency on ESPN.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deploying to Vercel

The app is a static export, so it fits comfortably in Vercel's free tier.

1. Push this folder to a GitHub repo.
2. At [vercel.com/new](https://vercel.com/new), import the repo.
3. Vercel auto-detects Next.js. Accept the defaults and deploy.

You get a URL like `league-history.vercel.app`. Share it — anyone can open it, no
login. To push an update, commit and push; Vercel redeploys automatically.

**Add to Home Screen** works out of the box via `public/manifest.json`. On iOS,
Share → Add to Home Screen; on Android, Chrome offers an install prompt. It opens
fullscreen with no browser chrome and no install warnings.

## Refreshing the data

Past seasons never change, so this is a once-a-year job after a season ends:

```bash
npm run refresh
```

That runs two steps, which you can also run separately:

- `npm run fetch` — pulls the public seasons (2019+) from ESPN into `data/raw/`
- `npm run merge:history` — splits the captured 2008–2018 dump into `data/raw/`
- `npm run build:data` — transforms raw dumps into `data/league.json`

Then commit `data/league.json` and push. The raw dumps are gitignored (~12MB of
mostly roster data we do not use); the derived file is 188K and **is** committed,
because Vercel builds from it.

## Merged accounts

Two managers registered more than once, and ESPN keys ownership by account GUID —
so without merging, their seasons would be counted separately.

**Chad Rissland** has three accounts:

| GUID | Handle | Seasons |
| --- | --- | --- |
| `{B6D2F68F…}` | Youhateme39 | 2019–2026 (primary) |
| `{02D15407…}` | crissl1470547 / chad39 | 2019–2020 |
| `{0A74113B…}` | ESPNfan4893280917 | 2021–2026 |

Verified they are one person rather than relatives: all three appear as
**co-owners of the same team (team 9) in every season** they exist, never
different teams. If they were different people, they would own different teams.

The merge lives in `scripts/owners.mjs` under `OWNER_ALIASES`. Because ESPN
records co-ownership at the team level, stats are keyed by franchise-season and
resolved to a person — summing per member GUID would have counted Chad's seasons
three times. His page shows a "3 accounts merged" badge.

**Steve Bazaar** has two: one for 2008, another for 2009–2014. Their windows
never overlap, consistent with re-registering rather than the franchise changing
hands.

To merge someone else later, add their GUIDs to `OWNER_ALIASES` and re-run
`npm run build:data`.

### Managers who left before 2019

ESPN only returns `members` records for the *current* roster, so five managers who
departed earlier have no name anywhere in the data. Their names come from the
league itself and live in `DEPARTED_OWNERS` in `scripts/owners.mjs`:
John Nicholson, Steve Bazaar, Matt Meyerhoff, and Ray Blakely.

## What counts as what

**Records are regular season.** ESPN's `record.overall` covers only the regular
season (15 weeks in recent years), while the schedule also contains weeks 16–17
playoff games. Folding those into the same totals would make head-to-head
disagree with the W-L shown everywhere else, so playoff meetings are tracked
separately and surfaced under each opponent on the manager pages.

The numbers reconcile exactly: 1030 regular-season game-sides + 140 playoff
game-sides = 1170 = 585 games × 2.

**2026 is excluded from records** — the season has not been played. It is still
fetched so rosters and membership stay current.

## Data validation

`scripts/build-stats.mjs` refuses to write `league.json` if any invariant fails:

- league-wide wins must equal losses
- every game must resolve to a person on both sides
- head-to-head wins must equal season-record wins
- exactly one champion per completed season

These are the failure modes that would otherwise ship silently — a broken alias
merge, an unresolved GUID, or head-to-head drifting out of sync.

## Season coverage

**All 18 seasons (2008–2025) are included**, but they come from two sources with
different depth:

| Seasons | Source | What we get |
| --- | --- | --- |
| 2019–2026 | Public API, fetched by `npm run fetch` | Full schedule, per-game scores, members |
| 2008–2018 | `kona_history_standings` dump, captured once by hand | Final standings only — records and ranks, no schedule |

So **season records, championships, playoff appearances, and finishes cover all
18 seasons**, while **head-to-head, per-game records, and points cover 2019–2025
only**. Every page that shows a scoped stat says so inline.

### Why 2008–2018 needed a manual capture

Those seasons are private (`401 AUTH_LEAGUE_NOT_VISIBLE`), and cookies alone do
not unlock them from a script — every endpoint variant returns 401 or 404 even
with a valid logged-in session. The ESPN web app reads them through:

```
leagueHistory/{id}?view=kona_history_standings&platformVersion=...
```

That exact URL returns 404 from curl with the same cookies, so the data was
captured once from the browser console and committed as `data/history-dump.json`.
`npm run merge:history` splits it into `data/raw/` without overwriting the richer
payloads for 2019+.

This is a one-time job: those seasons are finished and will never change.

## Notes on the ESPN API

- Two endpoint eras: seasons from 2018 on use
  `/seasons/{year}/segments/0/leagues/{id}`; earlier seasons are documented under
  `/leagueHistory/{id}?seasonId={year}`, which returns an **array of one** — but
  see above, it does not work for this league.
- ESPN moved the host to `lm-api-reads.fantasy.espn.com` around April 2024. The
  old `fantasy.espn.com` host now 302-redirects API calls to a marketing page.
- **401 means the season exists but is private; 404 means no data.** Do not
  conflate them — that is how the history first looked like it began in 2019.
- Requests need a browser-like `User-Agent` or ESPN rejects them.

## Layout

```
app/
  page.js            Landing page — high-level stats
  records/           All-time leaderboards, single-game extremes
  owners/            Manager list
  owner/[slug]/      Per-manager detail, prerendered for each
  h2h/               Full head-to-head grid
components/          Nav, RankRow
lib/data.js          Data access over league.json
scripts/
  espn.mjs           ESPN API client
  fetch-history.mjs  Pull all seasons -> data/raw/
  owners.mjs         Identity resolution and alias merging
  build-stats.mjs    Raw -> league.json, with validation
  make-icons.mjs     Generates PWA icons (no image deps)
data/
  raw/               Per-season ESPN dumps (gitignored)
  league.json        Everything the app renders (committed)
```
