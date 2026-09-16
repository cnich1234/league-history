# Going generic: what it would take

An assessment, not a plan of record. Written 2026-09-16 against the live
codebase: ~20,000 lines of app code, ~12,000 of scripts, 51 routes, 23 tables,
12 MB of static history.

The question: could someone else point this at their own Sleeper league and
have it work?

Short answer: yes, and it is a smaller job than it looks, because the app was
already built in a way that keeps the league out of the engine. The betting,
shop, DFS and Market code does not know what league it is running. The
coupling is concentrated in three places, and only one of them is hard.

## What is already generic

Worth stating first, because it is most of the app.

- **The engine.** `book.js`, `cron.js`, `live.js`, `shop.js`, `dfs.js`,
  `boosts.js`, `settle.js`, `odds.js` and all of `market/` import nothing from
  the history layer. Verified: zero references to `lib/data` or `league.json`
  in any of them. They take a season, a week and a Sleeper league id and work.
- **Roster shape.** `leagueSlots()` in `lib/live.js:79` already reads
  `roster_positions` from the Sleeper API, with `DEFAULT_SLOTS` as a fallback.
  A 12-team superflex league is already handled.
- **Auth.** Per-user scrypt passwords, a commissioner boolean in the database
  rather than a hardcoded name, HMAC session tokens. `lib/identity.js` and
  `lib/auth.js` contain no person-specific data.
- **Achievements.** All 30 definitions in `scripts/achievements.mjs` are
  computed from a week context. No slug, no person, no league id. Reusable
  as-is; only the scoring thresholds are league-flavoured.
- **Assets.** No per-owner photos or avatars ship with the app. Team logos come
  from Sleeper's CDN at runtime.
- **League id.** Already `process.env.SLEEPER_LEAGUE_ID` in nine of ten places.

## The three real problems

### 1. History is ESPN-shaped and frozen into the build

`data/league.json` is 412 KB of computed standings covering 2008-2025. It is a
static ESM import in `lib/data.js:9`, which means the home page, records, head
to head, owners and every owner page are prerendered from it at build time.
One build serves exactly one league's history.

The file itself is not the problem. Its shape is completely generic: slugs,
season records, head-to-head rows, game results. Nothing in it is ESPN-specific
once computed. The problem is the pipeline that produces it and the fact that
it is baked in at build time.

The pipeline cannot be re-run by anyone else. `fetch-history.mjs` needs ESPN
session cookies. `merge-history-dump.mjs` needs a JSON blob hand-copied out of
a logged-in browser console. `import-schedules.mjs` parses hand-pasted match
data. `owners.mjs` hardcodes three departed managers by ESPN GUID and merges
Chad's three accounts and Steve's two by hand.

**Sleeper can replace all of it.** Confirmed against the live API today: the
`previous_league_id` chain walks back from 2026 through 2025, 2024, 2023, 2022,
2021, 2020 to 2019 and stops. Eight seasons, automatically, no cookies.
`/users`, `/rosters`, `/matchups/{week}` and `/winners_bracket` supply
identity, results and champions for each one. A Sleeper-native history builder
is perhaps 200 lines and works for any league without console pasting or manual
reconciliation.

That leaves 2008-2018 as genuinely ESPN-only. For this league you would keep
those eleven seasons as a frozen archive file and append Sleeper-derived
seasons to it, which is a supported case rather than a special one: any league
migrating from another platform has the same shape. For everyone else the
archive is simply absent and history starts wherever Sleeper does.

### 2. Two identity systems bridged by hand

`lib/sleeper-owners.js` maps ten Sleeper user ids to ten slugs. It exists
purely because history is ESPN and live play is Sleeper, and the two have no
common key. The header documents that it was resolved from handle matches,
team-name carry-overs and elimination, then confirmed by hand. A comment
records the time it got Chris R and Chris Carmichael backwards and published
one man's championship as another's.

This file cannot be generated for a new league. It also does not need to be.
Sleeper has one stable `user_id` per person across every season, so going
Sleeper-native for history deletes this file rather than porting it. The whole
alias-merge problem is an ESPN artifact that evaporates.

That is the single most important finding here: the hardest piece of the
refactor is removed by the same change that fixes the history pipeline.

### 3. The database has no league dimension

`bettors.slug` is a bare primary key, and fourteen foreign keys point at it
from bets, ledger, boosts, bounties, DFS, market holdings, orders, dividends
and push subscriptions. Two leagues both containing a `chris-nicholson`
collide. The session token carries a slug and no tenant.

Roughly a dozen unique indexes are keyed on `(season, week, ...)` with no
league column, so two leagues would fight over the same markets, allowances and
trophy grants.

Six constraints would not merely behave oddly across leagues, they would fail
the insert outright for the second one:

| Constraint | Where | What breaks |
|---|---|---|
| `bettors.slug` as global PK | `db/001_schema.sql:19` | Two leagues cannot both have a Mike Brown |
| `dfs_one_weekly_per_week` on `(season, week)` | `db/020_dfs_contests.sql:33` | Second league cannot open its weekly contest |
| `markets_unique_idx` on `(season, week, kind, title)` | `db/004_unique_markets.sql:6` | Duplicate market titles rejected across leagues |
| `bounties_one_per_target_weapon_bet` | `db/016_collective_bounties.sql:53` | Worse than the rest: `poster` and `target` have no foreign key at all |
| `dfs_salaries` PK `(season, week, player_id)` | `db/019_dfs_salaries.sql:25` | Collides only when two leagues score differently, which they will |

Not every table needs scoping. `defense_ranks`, `market_baselines` and
`market_ticks` are NFL-wide facts keyed by player or team. Those stay shared
and get cheaper per tenant, not more expensive. `dfs_salaries` looks like one
of them but is not, because salaries are priced through the league's own
scoring settings.

Four views aggregate with no tenant filter and would silently sum every league
together: `bankrolls`, `prize_pool`, `point_balances` and `weekly_balances`.

There are also three module-level caches that would serve one league's data to
another inside a warm serverless instance: `slotsCache` in `lib/live.js:78`,
`_scoring` in `lib/dfs.js:107`, and neither is keyed by league. That is the
kind of bug that appears only under load and is miserable to trace.

### Honourable mention: the tuned numbers

Not a blocker, but worth knowing. A pile of constants were fitted to this
league and would be wrong, though not fatal, elsewhere:

- `LEAGUE_SD = 28` in `lib/odds.js:67`, fitted from 725 of this league's games.
  Every price in The Book derives from it.
- `PLACE_POINTS` in `lib/dfs.js:354` is a literal ten-element array. An eight
  or twelve team league gets zero points past tenth place.
- DFS salary cap, floor and points-per-dollar, tuned against this player pool.
- The whole boost catalogue in `lib/boosts.js`, priced against a 197-point
  season for ten managers.
- The assistant's system prompt says "10-manager" in `lib/assistant.js:205`.
- `BOOK_FIRST_WEEK` defaults to 2 because *this* league wiped its week 1.

## A bug worth fixing regardless

`ledger_allowance_once` in `db/013_weekly_allowance.sql:22` is unique on
`(bettor, week)` with no season. The `ledger` table has no season column at
all. The points ledger got this right, with `(bettor, season, week)` in
`db/012_boosts.sql:28`, but the money ledger did not.

Nothing is wrong today. Next season, week 3's allowance would silently fail to
pay because week 3 of 2026 already holds the row. Worth fixing in whatever pass
touches the schema next, independent of any of this.

## Two ways to do it

### Option A: one deployment per league

Strip the league-specific data, make every constant an environment variable,
and let each league run its own Vercel project and its own Neon database.

- No schema change at all. No tenancy, no collisions, no session redesign.
- The build-time history import stops being a problem, because each build is
  for one league by definition.
- Setup is: fork or clone, set `SLEEPER_LEAGUE_ID`, run an import script, deploy.
- The work is mostly deletion and config plumbing.

This gets you to "someone else can run it" quickly and safely. It does not get
you to "someone signs up on a website".

### Option B: true multi-tenant

One deployment, many leagues, a signup flow.

- Add `league_id` to `bettors` and every table that references it. Rework the
  dozen unique indexes to include it.
- Put `league_id` in the session token and thread a tenant through every query
  in `book.js`, `shop.js`, `dfs.js` and `market/`. That is where the real hours
  go, and it is the kind of change where one missed `where` clause leaks one
  league's bets into another's board.
- Move history out of the static import into the database, and convert the
  prerendered history pages to dynamic routes.
- Replace the login dropdown, which currently lists every manager before you
  authenticate, with something that scopes to a league first.
- Per-league branding means a dynamic manifest, since `public/manifest.json`
  is static and names the league.
- Crons become per-league fan-outs rather than one job.

## Recommendation

Do Option A, and do it in a way that does not close the door on B.

The reason is that Option A's work is almost entirely a subset of Option B's.
Deleting the ESPN pipeline, writing the Sleeper history importer, removing
`sleeper-owners.js`, moving constants to config, and fixing the hardcoded bits
all have to happen either way. Tenancy is the only part unique to B, and it is
the part with the real risk.

So: do the shared work first, ship a version another league can actually run,
and find out whether anyone wants it before paying for multi-tenancy.

## Sequence

1. **Config seam.** One `lib/config.js` that reads the league id, season,
   first week, timezone and branding once, instead of
   `process.env.BOOK_SEASON ?? 2026` repeated across fifteen files. Fix
   `components/LiveScores.js:8`, which hardcodes the league id with no env
   fallback and would silently serve another league's scores.
2. **Sleeper history importer.** Walk `previous_league_id`, build the same
   `league.json` shape from `/users`, `/rosters`, `/matchups` and
   `/winners_bracket`. Keep the output contract identical so `lib/data.js` and
   all five history pages keep working untouched.
3. **Retire the ESPN era.** Freeze 2008-2018 into one archive file, then drop
   `espn.mjs`, `fetch-history.mjs`, `merge-history-dump.mjs`,
   `import-schedules.mjs`, `owners.mjs`, `data/raw/` (12 MB) and
   `data/history-dump.json`. Once history is Sleeper-native,
   `lib/sleeper-owners.js` goes too, because the thing it bridges no longer
   has two sides. Also drop `build-player-map.mjs`, which reads an absolute
   path into a different repo on one laptop, and `lib/weekly.js`, which reads
   a file that no longer exists.
4. **Soften the empty-league case.** `build-stats.mjs` hard-fails the build on
   invariants a first-year league violates. Turn those into warnings. The
   history pages render blank rather than crashing, but the head-to-head grid
   needs 20 games to show anyone, so it should say so instead of being empty.
5. **Defaults for the unfittable.** `LEAGUE_SD = 28` was fitted from 725 games
   of this league's history. A new league has nothing to fit, so it needs a
   sane default and a note that `npm run fit:sd` improves it after a season.
6. **Branding and strings.** League name from config into the manifest, layout
   title and openGraph. Replace "Ask Chris to reset it" with the commissioner's
   display name, which is already in the database. Drop `MARKET_TESTERS` and
   `content/writeups/`.
7. **Setup path.** A single script that takes a Sleeper league id, imports
   history, seeds bettors from Sleeper users, and runs the migrations.

Steps 1 through 3 are the bulk of the value. Everything after is polish.

## Rough size

Sessions of the kind that built the Market and the lineup fix, not hours.

| Work | Size | Risk |
|---|---|---|
| Config seam, hardcoded fixes, branding | small | low, mechanical |
| Sleeper history importer | medium | low, new code beside the old |
| Retire ESPN, delete dead scripts | small | low, deletion |
| Empty-league handling and defaults | small | low |
| Setup script and docs | small | low |
| **Option A total** | | **contained** |
| Tenancy migration across 23 tables | large | **high** |
| Threading league through every query | large | **high**, a missed filter leaks data |
| History to DB, dynamic routes, login rework | medium | medium |

Option A is a weekend of focused work. Option B is a different project, and
the risk is not in the schema migration but in the several hundred queries that
each need a tenant filter nobody will notice is missing until two leagues are
live.

## What this does not solve

The timezone rule. `lib/schedule.js` locks bets at midnight Arizona and
documents that Arizona has no daylight saving, so the offset is a constant
-07:00. That is correct here and wrong everywhere else. It needs to become a
per-league timezone with real DST handling, which is a small change with a
sharp edge: get it wrong and bets lock an hour late during the season.

The writeups. Recaps are generated with knowledge of these ten people and their
history. Generic recaps would be blander, or would need per-league lore that
nobody else has written.

And the obvious one: this app is opinionated. The Book, the shop, bounties,
DFS and the Market are a specific set of games with specific numbers, tuned for
ten friends who talk trash. Making it run for another league is a code problem.
Making another league *want* it is not.
