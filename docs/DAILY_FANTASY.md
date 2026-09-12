# Daily Fantasy

**Status: built and running.**

Salaries, contests, lobbies, the lineup builder, per-player locking, scoring,
settlement, the cron wiring and a live results page all exist. Weeks 1-3 of
2026 are priced.

Not built: push notifications, and any view of DFS history beyond the current
week.

Two modes, both feeding the same points economy as the Trophy Room and The Book:

1. **The Weekly** — one contest a week, everyone in, points are **minted** by
   finishing position.
2. **Lobbies** — private contests anyone can open, points are **recycled**:
   buy-ins pooled, winner takes all.

---

## 1. What already exists

More than you would expect. The hard parts of a DFS product are a player pool, a
scoring engine and a settlement path, and all three are here:

| Need | Status |
|---|---|
| Player pool | `sleeper-players.json`, ~1,000 players with position and team |
| Weekly projections | `api.sleeper.com/projections/nfl/{season}/{week}` |
| Actual scoring | `api.sleeper.com/stats/nfl/{season}/{week}`, already used for props |
| Points ledger | `point_ledger`, append-only, balances derived |
| Kickoff times | `lib/schedule.js` — `teamGameDates`, `lockTimeFor` |
| Live game state | `lib/live.js` — `hasKickedOff`, `fractionRemaining` |
| A weekly cron | `/api/cron`, Tuesdays 09:00 UTC |

## 2. What does not exist: salaries

**Sleeper has no salary field.** Checked every key on a player record: nothing
salary-, price-, cost- or cap-like. This is the only genuinely missing piece.

The fix is to derive them from the projections we already fetch:

    salary = round100(FLOOR + projection x PER_POINT)

At `FLOOR = 3000`, `PER_POINT = 450`, week 1 of 2026 prices out as:

| Position | Priced | Most expensive | Cheapest |
|---|---:|---|---|
| QB | 32 | Jalen Hurts $13,200 | Cooper Rush $7,900 |
| RB | 92 | Jahmyr Gibbs $11,900 | $3,000 |
| WR | 156 | Puka Nacua $10,700 | $3,000 |
| TE | 99 | Colston Loveland $8,100 | $3,000 |
| DEF | 32 | $7,300 | $4,600 |

**411 players project above zero** — a real pool, not a token one.

And the cap binds, which is the entire point. A lineup of the top-projected
player at every slot costs **$93,700 against a $50,000 cap** — nearly double. You
cannot roster chalk everywhere; something has to give.

Two things to know about deriving salaries this way:

- **Prices follow projections, so they are only as good as Sleeper's.** A player
  Sleeper rates low is cheap whether or not he deserves to be, which is exactly
  where the edge in DFS lives. That is a feature.
- **Defences have no name in the player file** — they price fine but render as
  `?`. Needs a lookup from team abbreviation.

## 3. The Weekly

One contest, everyone entered, scored on Sleeper's numbers for that NFL week.

### Lineup and cap

Standard DFS shape, matching the league's own lineup so it reads as familiar:

    QB, RB, RB, WR, WR, WR, TE, FLEX (RB/WR/TE), DEF     cap $50,000

### Payouts — the open question

Points here are **new money**, and that is the thing to get right. Modelled
against a current season income of 197 points per manager (99 trophy + 7/week
allowance over 14 weeks):

| Curve | Minted per season, per manager | Share of income |
|---|---:|---:|
| 1st = 20, decaying to 0 | +111 | **36%** |
| 1st = 20, only top 3 paid | +70 | 26% |
| 1st = 10, decaying | +56 | 22% |
| 1st = 20, winner only | +28 | 12% |

The 1st = 20 decaying curve pays 20/17/13/10/8/5/3/2/1/0 — **79 points a week
across the league, 1,106 a season.** That is more than five times the total
points in circulation today, and would make DFS the dominant source of income in
the app rather than a third pillar beside trophies and the allowance.

You said you are happy to leave the boost prices as they are. Worth being
explicit that at the full curve, boost prices would effectively fall by a third
in real terms: a 75-point Undo is 38% of a season's income today and 24% after.

Cheapest fix if that is not wanted: **pay fewer places.** Top 3 only, or halve
the top prize. Both keep the "finish well, earn points" feel while minting far
less.

## 4. Lobbies

Private contests, and the more interesting half.

- Anyone opens one: **seats** (2–10) and a **buy-in** in points
- Buy-in is escrowed at entry, exactly as bounty contributions are
- Fills up, locks at first kickoff, **winner takes the pot**
- Nothing is minted: points move between managers

**Net zero by construction.** This is the safe half of the feature — it cannot
inflate the economy no matter how much gets wagered, so it can be tuned freely.

Rules that fall out of the existing patterns:

- Escrow on entry, because a pledge nobody can cover is not a pledge — the same
  rule bounties already enforce
- An unfilled lobby refunds everyone at lock time
- One lineup per manager per contest
- Ties split the pot, remainder to the largest... except every buy-in is equal,
  so remainder goes to the earliest entrant

## 5. Locking and scoring

Reuses what The Book already does:

- A lineup locks at the **earliest kickoff among its own players** — the same
  rule a parlay leg follows, so someone rostering only late games keeps editing
- Live scores from the same endpoint the board polls
- Settled by the Tuesday cron, after Sleeper's numbers are final

## 6. Decisions

### Settled

**The payout curve: the full decaying 1st = 20.**

    1st  2nd  3rd  4th  5th  6th  7th  8th  9th  10th
     20   17   13   10    8    5    3    2    1    0

79 points a week across the league, 1,106 a season. Chris took the inflation
point and accepted it: DFS becomes the largest single source of points in the
app, and boost prices fall by roughly a third in real terms. That is the
intended shape, not a side effect -- the shop was repriced upward on the
assumption of a 197-point season, and this is a deliberate loosening of it.

**Roster limits: none.** Anyone can roster anyone, standard DFS. The chalk
lineup is unaffordable anyway -- $100,100 against a $50,000 cap -- so
differentiation comes from the budget rather than from a rule.

**Lineup: the league's own Sleeper roster**, read from the league API rather
than invented:

    QB, RB, RB, WR, WR, WR, TE, FLEX, K, DEF     cap $50,000

FLEX takes RB, WR or TE. This puts kickers back in the pool -- they were
excluded as "too random" until the lineup was settled. They price into a narrow
band, about $3,100 to $6,400 against $13,200 for the top quarterback, so a
kicker is closer to a fixed cost than a real decision. Which is true of kickers.

**Salaries refresh weekly.** Each week is priced from its own projections, so a
breakout gets dearer and a fade gets cheaper. Frozen WITHIN a week: Sleeper
revises projections right up to kickoff, and a lineup that was legal when it was
built has to stay legal.

## 7. Build order, once those are settled

1. `dfs_salaries` — season, week, player, position, salary. Built by the cron.
2. `dfs_contests` and `dfs_entries` — the weekly plus lobbies, one table each.
3. Lineup builder UI — the real work, and the part that has to feel good on a
   phone.
4. Locking, live scoring, settlement into `point_ledger`.
5. Its own nav icon, as discussed.

All of the above is built. Player photos come from Sleeper's CDN -- no key, no
rate limit, keyed by player id, with team logos standing in for defences. A
player without one returns 403 rather than a placeholder, so the component
falls back to initials.

The results page shows every lineup scored live, and appears only once a
contest has LOCKED: publishing an open one would let the last person in copy
the best lineup on the board.
