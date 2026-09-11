# The Book — how it works

A play-money sportsbook bolted onto the league history app. Ten managers, $1,000
each, most money at the end of the season wins $200. Run out and you can re-up
for $20, which goes into the pot.

This document covers how the thing actually works, with emphasis on live betting
— the part with the most moving pieces and the part that has broken the most
often.

---

## The one rule that explains most of the design

**The server prices every bet.** The number on your screen is treated as "here
is what I was shown," never as "here is what I should be charged." It is used
for exactly one thing: rejecting a fill if the price moved while you were
tapping.

A client that could name its own odds could name any odds. Everything else
follows from not allowing that.

The same discipline applies to the hiding rule. It lives in the SQL query, not
in the UI — a component that forgets to filter leaks everyone's picks, but a
query that never selects them cannot.

---

## When markets close

This is the part that has been wrong the most, so it is worth stating plainly.

| Market kind   | `live`  | Closes when                                              |
| ------------- | ------- | -------------------------------------------------------- |
| Player prop   | `false` | That player's NFL game **kicks off**                     |
| Matchup (h2h) | `true`  | One side reaches **90%**, or the games end               |
| Spread        | `true`  | Same                                                     |
| Team total    | `true`  | Same, on that team's own progress                        |
| Special       | `false` | The week's **first kickoff** -- every lineup is involved |

**Only props close on the clock.** Everything else never closes on time at all —
once games start the price moves with the score instead. A matchup with one
Thursday starter stays bettable all weekend; it just gets more expensive to back
the side that is winning.

### `locks_at` is not a deadline

Every market carries a `locks_at` timestamp, and it is easy to misread. It is
**midnight Arizona time on the morning of the game** — which for a Thursday or
Sunday night kickoff is some eighteen hours before anything happens.

For a live market it marks only the moment pricing switches from the posted line
to the live model. For a prop it is a lower bound, not the close.

Anything that treats `locks_at <= now()` as "finished" is a bug. That single
mistake caused four separate incidents:

- parlays refusing live legs as "locked"
- team totals suspending because their state lookup keyed on the wrong field
- the board hiding the most active markets
- **a bet going public on The Floor while its game had not kicked off**

The rule now is uniform: **`status` is the only closing test.** Status is set by
`lockDueMarkets()` from facts Sleeper reports — kickoff for props, game-final for
live markets — never inferred from a timestamp.

### Who sets the status

`lockDueMarkets(finishedRosters, kickedOffTeams)` in `lib/book.js`. Both
arguments default to empty, and **empty means "nothing has happened yet," so
nothing locks.** Not knowing is never a reason to close a market — an open
market is still governed by `shouldSuspend` at pricing time, so nothing can be
bet at a decided price either way.

It runs on the live poll (below), with the weekly cron as a backstop.

---

## Live betting

### Where the numbers come from

Sleeper, on three endpoints — two of them undocumented:

```
api.sleeper.app/v1/league/{id}/matchups/{week}     starters + points so far
api.sleeper.com/projections/nfl/{season}/{week}    pts_ppr per player
api.sleeper.com/scores/nfl/regular/{season}/{week} per-game quarter flags
```

Sleeper is **not** a push API, despite claims to the contrary. Their own web app
opens no WebSocket and no EventSource. It is polling or nothing.

### The model

Stern (1994), the standard for in-play sports pricing. The outcome is Brownian
motion: variance is additive over time, so the standard deviation of what is
_left_ scales with the square root of how much is left.

```
remaining SD = LEAGUE_SD × √(remaining projection / total projection)
```

Points already scored carry **no variance at all** — they shift the centre of the
distribution and nothing else.

The unit of "time" is projected points still to be played, not a game clock,
because a fantasy matchup has no clock. It has twenty players spread across five
days. A 30-point lead on Thursday night means almost nothing (95% of the scoring
is still to come); the same lead on Sunday evening is decisive.

### `LEAGUE_SD = 28`

Fitted to this league, not guessed. 28.0 from **725 regular-season games across
2016–2025**, measured as `sd(margin) / √2` — the margin is what the model prices,
and it cancels league-wide weekly effects that lift both scores at once.

It was a guess of 25 before. Season by season the figure ranges 22–31 with no
trend, so there is no case for weighting recent years. Re-fit any time:

```bash
node scripts/fit-sd.mjs
```

The normal assumption holds up: 28.6% of games are decided by a full margin-SD or
more, against the 31.7% a normal distribution predicts.

### Players mid-game

A player who is two thirds through their game has a third of their projection
still to come, and only that third carries variance. Quarter granularity is what
Sleeper exposes — there is no game clock in the payload — so `fractionRemaining`
steps:

| Game state     | Remaining |
| -------------- | --------- |
| Not kicked off | 1.0       |
| 1st quarter    | 1.0       |
| 2nd quarter    | 0.75      |
| 3rd quarter    | 0.5       |
| 4th quarter    | 0.25      |
| Overtime       | 0.1       |
| Final          | 0         |

Overtime is bonus scoring on top of a finished four quarters, so it is treated as
nearly over rather than as a fifth quarter of expected production.

Coarse, but far better than the binary it replaced — which counted any player
with points on the board as finished.

> **Do not trust `has1st_quarter_started`.** Sleeper had it set to `true` on
> SF@LAR while the game was `pre_game`, with an empty quarter and kickoff eight
> hours away. Only `status`, `has_started` and `is_in_progress` say whether a
> game has begun; the quarter flags say how far along a game that _has_ begun
> is. Believing the flag locked six props early and put a bet on The Floor
> before a ball was thrown.

### Bye weeks

Byes begin in **week 5** and take four or five teams out at a time, so for most
of the season several starters in the league have no game.

Two bugs met here and compounded. `projections[id] ?? 9` invented nine points
for anyone missing from the projections map — which a bye player usually is —
and `fractionRemaining(undefined)` returns 1, because an unknown game is treated
as _not yet kicked off_ rather than as no game at all. A bye starter therefore
contributed a full nine points of "still to come" that could never arrive.

The damage was not cosmetic. A lineup ten points down late in the week with two
bye starters priced at **73% to win instead of 10%**, and the market stayed open
because the model believed eighteen points were coming.

A starter whose team has no game this week now contributes nothing. A player
with no _identifiable_ team still gets the placeholder — that is ignorance, not
evidence of a bye, and dropping them would understate a lineup that does have
people playing.

The same fallback existed in market generation (`projectPlayer` in `lib/cron.js`
fell through to `BASELINE`), inflating any total or spread a resting player
touched. Fixed the same way, from `gameDates`.

### When a market suspends

`shouldSuspend(probability, remainingShare)` — two triggers, either closes it:

- one side reaches **90%**
- less than **10%** of projected scoring is left

Books close on probability, not on a clock. No sportsbook publishes a time
threshold; they all close when one side becomes near-certain, because at 97/3
anyone with a few seconds of information advantage captures nearly the whole 3%
at no risk.

> **Implementation note.** It compares the leading side —
> `Math.max(p, 1 - p) >= threshold` — rather than testing both ends. The obvious
> `probability <= 1 - threshold` fails on floating point: `1 - 0.9` is
> `0.09999999999999998`, so an exact 10% stayed open.

### Stake limits taper

A $250 bet on a coin flip and a $250 bet on something 88% decided are very
different animals. Real books handle this with discretionary limits that shrink
as certainty rises — none publishes a formula, so this is a deliberate choice
rather than an industry rule.

| Certainty | Max stake |
| --------- | --------- |
| 50%       | $250      |
| 75%       | $250      |
| 85%       | $125      |
| 90%       | closed    |

Full limit while it is a genuine contest, then a straight-line taper from 75% to
the 90% threshold, floored at the $10 minimum so a market that is still open is
always still bettable.

A parlay is capped by its **tightest** leg.

### The vig

|         | Margin |
| ------- | ------ |
| Pregame | 4.5%   |
| In-play | 9%     |

Industry hold roughly doubles in-play (4–6% becomes 7–12%) for a mechanical
reason: as the remaining standard deviation shrinks, a fixed percentage margin is
a smaller and smaller absolute cushion, while a bettor's timing advantage does not
shrink at all.

Both sides get half the margin added, and nothing is ever quoted past 97%.

`LIVE_MARGIN` is exported from `lib/live.js` and used by **both** the board and
the placement path. It was briefly duplicated — the board quoted 4.5% while
placement computed 9% — which made the staleness guard fire on every single live
bet.

### Polling

**30 seconds**, matched to the data rather than to our own speed.

The recompute takes about 60ms, but Sleeper's matchups endpoint sits behind a
Cloudflare cache with `s-maxage=60` (verified from the response headers), so the
numbers are up to a minute old no matter how often we ask. Polling at 15s
returned byte-identical responses roughly four times in a row.

`LiveProvider` runs **one poll for the whole board**, shared by every matchup
card via context. Each card polling for itself meant five identical requests per
user per tick — at 15s with ten people that is 200 requests a minute, roughly
half of Vercel Hobby's million monthly invocations across a season. Overage there
**pauses the project for 30 days** rather than sending a bill.

A backgrounded tab stops polling entirely. Browsers throttle timers there anyway,
but stopping outright avoids a burst of catch-up requests when the tab returns.

### Locking rides on the poll

`/api/live` closes what is over, using the state it just fetched. This is
deliberate: a live market has to shut within minutes of its game ending, and
**Vercel Hobby only allows daily crons.** The route already runs every 30s with
exactly the data the decision needs.

A lock failure never fails the response — the board matters more than the
bookkeeping, and the next tick retries.

The 25s edge cache bounds how long a finished market stays open, since locking
happens on a cache miss. With ten people watching, misses are constant. If nobody
has the app open — a Monday night game ending at 11:30pm — markets stay `open`
until someone opens it or the Tuesday cron runs. Nothing can be bet at a decided
price meanwhile, because `shouldSuspend` still governs every quote; the only
effect is that those bets stay off The Floor a little longer.

---

## Position battles and blowout lines

**Position battles** (`kind: 'showdown'`) are a spread scoped to a position
group: one manager's starting QBs/RBs/WRs/TEs against the other's, with a
handicap. Structurally a spread — cover/nocover, half-point line, same normal
model — but it needs its own kind so the resolver knows which players to compare.

Two rules carry the money:

- **Only starters count.** A 30-point WR on the bench scored his manager nothing
  and must not decide the bet.
- **A side that started nobody voids**, rather than losing. There was never a bet
  to win. Note that scoring _zero_ is different from not starting anyone, and the
  resolver distinguishes them.

The standard deviation is scaled: `(LEAGUE_SD / 3) × √players`. `LEAGUE_SD` is
fitted to a whole nine-man lineup, so applying it to a single TE would price
every battle as a coin flip.

**Blowout lines** ask "does _either_ team win by more than the line", with one
option per manager, at 20.5 and 30.5. They are `spread` markets flagged
`meta.blowout`, and the option key is a roster id.

They have **three outcomes, not two**: the third is a close game, where both
backable sides lose. That is what lets both be plus money — "neither" is the
likeliest result (37–56% depending on the line) and pays nothing.

Which is why `twoWayOdds` is wrong for them. It splits a margin across two
outcomes summing to 1; these two sum to well under it, and pricing them as a pair
quotes both far too short. `fieldOdds` prices the whole field including the
outcome nobody can back.

`'nobody'` needs no special handling in `settleMarket`: it is not a refund
keyword and no bet holds it as an option key, so everyone loses, which is correct.

Neither blowouts nor battles are live-priced — see below.

### What trades live

`createMarket` sets `markets.live` from the kind. It did not always: the flag was
set once by migrations 008 and 009 for the markets that existed then, and
`buildWeek` never set it — so **every week built afterwards came out entirely
non-live**, and week 2's matchups would have shut at kickoff instead of
repricing. Silent, because a non-live market looks perfectly normal until the
games start.

| Kind                       | Live   |
| -------------------------- | ------ |
| h2h, spread, total         | yes    |
| prop, special, showdown    | no     |
| spread with `meta.blowout` | **no** |

A blowout is the exception among spreads. `livePrice` and the client's
`pricesFor` both return null for one, because the live spread model does not
describe a three-outcome field — it has no `favouriteSlug`, and the
`cover`/`nocover` keys it returns match none of the market's options. Left
unpriced it suspends once games start, rather than quoting a number that means
something else entirely.

---

## Special bets

Four league-wide markets a week: highest scoring team, and the best starting RB,
WR and TE in the league.

They are structurally unlike everything else — **one market for the whole league
with one option per manager**, belonging to no matchup. The option key is a
roster id, so settling is just "whose roster owns the winner." They get their own
section above the board because there is no game card to file them under.

They are **team bets**: you back a manager, and whoever he started counts.

Three rules that matter:

- **Only starters count.** A 40-point RB on someone's bench earned his manager
  nothing and must not win him the bet either.
- **Ties push.** Two managers can genuinely share a high score; picking one
  arbitrarily would take money off someone who was not wrong. One manager
  starting two tied players is _not_ a tie — there is still one winner.
- **They lock at the week's first kickoff**, not the last. Every lineup is
  involved, so the earliest game decides it.

### Pricing a field

`twoWayOdds` cannot price these — it splits a margin across exactly two sides. A
ten-way book has to sum to `1 + margin` with each price its own share, which is
what `fieldOdds` does. Weights come from projections (whole lineup for the team
market, best starter at that position otherwise), normalised, with the margin
added proportionally and every outcome floored at 1%.

Holds the same 4.5% as any other pregame market.

> A roster with **no starter** at that position is left out of the field entirely
> rather than priced as a longshot it cannot possibly win.

> `lockDueMarkets` needed its own branch for these. They carry no `nflTeam`, and
> `meta->>'nflTeam' = any(...)` against NULL is never true — so without it a
> special market would never have locked at all.

---

## The read-only guest

A "Guest — just looking" option in the sign-in dropdown, no password. It sees
the board, live prices, standings and settled results; it cannot bet.

The design decision worth keeping: **a guest is not a row in `bettors`.** Its
slug is a reserved sentinel (`__guest__`) that no manager can be given. A guest
with a real slug would flow into `placeBet`, `getMyBets` and the bankroll view as
though it were a manager — able to own bets and hold money. Outside the table,
every query that joins on a bettor simply finds nothing, which is the right
answer rather than a special case someone has to remember.

`currentBettor()` answers "is someone signed in". `currentManager()` answers "is
someone signed in who can own things" — it returns null for a guest, and it is
what the write routes use. Reaching for the wrong one is how a guest would end
up debiting a bankroll that does not exist.

Read-only is enforced in three places, deepest first:

1. `placeBet` / `placeParlay` reject the guest slug at the data layer, so a
   direct POST fails too.
2. `/api/bet` and `/api/parlay` return 403 via `currentManager()`.
3. The UI passes `readOnly` down to every `BetSlip`, so the controls never
   invite a tap that would fail.

`isCommissioner()` short-circuits on a guest without touching the database, so
the Admin tab and its endpoints are closed as well.

Identity lives in `lib/identity.js` rather than `lib/auth.js`: auth imports
`next/headers` for cookie access, which will not resolve outside a Next request,
so the guest rules could not otherwise be tested with plain `node`.

---

## Points and boosts

The Trophy Room feeds The Book. Weekly achievements pay **trophy points**, and
trophy points buy **boosts** that change real money.

### The economy

Two sources, deliberately about half and half over a season:

|                              | Season | Share |
| ---------------------------- | ------ | ----- |
| Weekly allowance (5/wk × 14) | 70     | 51.6% |
| Trophies                     | ~65.6  | 48.4% |

The trophy figure is simulated, not guessed — `npm run sim:points` runs 4,000
seasons against the same fitted `N(120, 28)` the betting model uses. Re-run it
after any change to an award's value; the split is the number to keep near 50/50.

There is no weekly history to replay (`data/history-dump.json` holds season-end
standings only), so the simulation is the only calibration available until real
weeks accumulate.

### No achievement is negative

Points buy boosts, so docking the manager already losing on the field would
compound a bad season into a bad season with nothing to do about it. Scoring the
league low pays **+2**. Four awards can be won _while losing_ — Bottom of the
Barrel, Nice Score Still Lost, So Close, and Beat the Spread — which is the floor
that keeps a struggling manager in the store.

`Beat the Spread` is the strongest of them: a team projected to lose by 25 that
loses by 8 earns it. Completely decoupled from record.

### Two families of boost

The distinction decides _when_ a boost can be used:

- **PAYOUT** boosts change what a settled bet pays. Safe to use after a market
  locks, because the money has not moved yet.
- **PRICE** boosts change what a bet costs to place. Cannot be used after bets
  exist at the old number — that would rewrite history.

`applyBoosts` fixes the order: multiply up, then take any cut, so a skim always
bites the number the winner expected to see. A **refund is never boosted** — a
push is not a win. `The Void` short-circuits the chain entirely, since nothing
applied afterwards can bring a voided bet back.

### Why three attacks are not buyable

Grand Theft, Blind Sabotage and The Void all need to name a specific bet or
bettor — and bets are hidden until their market locks. Listing someone's bet in a
picker would leak their position, which is the rule the whole book rests on. They
are shown in the store and refused in `buyBoost`, not merely greyed out.

`Poison the Well` works today because it targets a **market**, which everyone can
already see.

---

## Hiding bets — The Floor

Nobody sees anyone else's picks until nobody can act on them. That is the whole
"no copying, no tailing" rule, and it rests on a single query:

```sql
-- lib/book.js :: visibleBets
where m.season = $1 and m.week = $2
  and m.status <> 'open'
```

One condition for every kind of market, because "open" is exactly the thing that
decides whether anyone can still act.

It was briefly `m.live = false or m.status <> 'open'`, which _looks_ like it
handles both cases but lets every prop through on its posted time alone — and a
prop's posted time is midnight on the morning of the game. That is how a $25
Stafford bet went public while the game was still hours away.

**Failure mode if locking ever stops:** markets stay `open` and these bets stay
hidden. Hiding too much is the safe direction.

---

## Parlays

2–6 legs, each on a different market. Every leg must win.

Odds multiply in **decimal** space, not American. Two -110 legs are not -220,
they are roughly **+264**, because you are re-staking the first leg's return on
the second.

- A live leg is priced live, exactly like a straight bet.
- A **prop** leg is the one that can shut a slip, since props close at kickoff.
- A voided leg **drops out** and the rest are re-priced — a two-leg slip with one
  dead leg becomes a straight bet on the survivor, not a whole refund.
- The slip is capped by its tightest leg's limit.

Straight bets and parlay legs are **mutually exclusive** on the same market. They
did not used to be: "Review" and "+ Parlay" sat side by side and read as
sequential steps, so someone placed two singles _and_ a parlay and got charged
$100 for what he thought was a $25 slip. Refunded, and the paths were made
exclusive.

---

## Money

An **append-only ledger**. Bankroll is a derived view, never a stored number, so
a balance can always be explained by summing its own rows. Several tests assert
exactly that invariant, because it is the one that would catch a settlement or
payout bug.

Stakes are debited at placement. Payouts land at settlement.

Re-ups are recorded in two places on purpose: the $20 is real money owed to the
prize pool, the $1,000 bankroll credit is play money in the ledger. Someone who
has re-upped four times has spent $80.

---

## Layout

```
lib/
  odds.js      all betting math — probabilities, prices, limits, parlays
  live.js      Sleeper state, live pricing, kickoff + final detection
  book.js      data access; every rule that matters is enforced here
  settle.js    resolving a market from final scores
  cron.js      building a week's board, settling a week
  schedule.js  lock times from the NFL schedule

app/api/
  live/        30s poll: live state + opportunistic locking
  bet/         place a straight bet
  parlay/      place a parlay
  cron/        weekly upkeep (Tuesday 09:00 UTC)

components/
  LiveProvider.js   one shared poll, context-distributed
  BetSlip.js        one market, with review-then-confirm
  ParlaySlip.js     the slip
  MatchupCard.js    one card per game, every bet on it inside
```

### Database

Neon Postgres, 9 migrations in `db/`. The ones that matter:

|       |                                                                                              |
| ----- | -------------------------------------------------------------------------------------------- |
| `002` | bankroll view fan-out — joined ledger _and_ bets, multiplying balances by bet count          |
| `005` | individual passwords (scrypt + per-user salt), so league mates cannot read each other's bets |
| `007` | parlays — `market_id` and `option_key` become nullable                                       |
| `008` | `markets.live`                                                                               |

`008` also creates a `live_quotes` table that nothing reads or writes — prices are
computed on demand rather than stored. It is harmless but dead.

---

## Tests

Sixteen suites, run individually:

```bash
npm run test:lock      # what closes, and when — the rule above
npm run test:live      # the live model
npm run test:livebet   # server-side live pricing
npm run test:floor     # the hiding rule
npm run test:odds      # probabilities, parlay math, stake taper
npm run test:parlay    # parlay settlement
npm run test:book      # placement rules end to end
```

Ones against the real database use a **sentinel season** (9995–9999) and clean up
in a `finally`, so a failing assertion can never leave a real bankroll wrong.

> Two suites once passed for the wrong reason: a `ReferenceError` satisfied a
> "not rejected as locked" assertion, and a stale `$1000` bankroll assertion held
> only until real bets existed. Both are now guarded explicitly. A test that
> cannot fail is not a test.

---

## The shape of the bugs

Live betting broke five separate things, and every one had the same shape:
**code that assumed "past its lock" means "finished."**

1. `placeParlay` rejecting live legs as locked
2. `stateForMarket` keying totals on a missing field — `"undefined-undefined"`
3. the board and placement computing different margins
4. The Floor revealing live bets while they were still bettable
5. The Floor revealing **prop** bets before their game kicked off

There was also a sixth, of a different kind: `lockDueMarkets()` was **dead code**
for the whole season. Nothing called it, so no market had ever left `status =
'open'` — and two separate mechanisms were quietly leaning on a status that never
changed.

If another one turns up, that is the shape it will take.
