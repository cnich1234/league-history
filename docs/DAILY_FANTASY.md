# Daily Fantasy

**Status: designed, not built.** This records how it would work, what already
exists, what does not, and the four decisions needed before writing code.

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

## 6. The four decisions

1. **The payout curve.** Full decaying 1st = 20 mints 1,106 points a season and
   makes DFS the biggest earner in the app. Top-3-only mints 70 per manager.
   Which?
2. **Roster limits.** Can two managers both roster Gibbs? Standard DFS says yes.
   Unlimited duplication makes the chalk lineup the safe play; a cap of 3-4
   entries per player forces differentiation in a 10-person field.
3. **Lineup shape.** The league lineup above, or something shorter? Nine slots
   from a 411-player pool is a real weekly chore, and this has to stay fun.
4. **Salary refresh.** Recompute every week from that week's projections
   (prices chase form), or set once in preseason (prices go stale but a breakout
   stays cheap and rewards whoever spotted it)?

## 7. Build order, once those are settled

1. `dfs_salaries` — season, week, player, position, salary. Built by the cron.
2. `dfs_contests` and `dfs_entries` — the weekly plus lobbies, one table each.
3. Lineup builder UI — the real work, and the part that has to feel good on a
   phone.
4. Locking, live scoring, settlement into `point_ledger`.
5. Its own nav icon, as discussed.

Nothing here is built. The salary model in §2 was run against real week-1 2026
data to confirm the numbers, but no table, endpoint or page exists yet.
