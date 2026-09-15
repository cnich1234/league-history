# The Market

A play stock market where every NFL player is a ticker. You buy shares with
points, watch the price move, and sell when you like. Watchlist, charts,
trading and dividends are all live as of 2026-09-15.

**Open to anyone signed in**, trading included. `MARKET_OPEN` and
`MARKET_TRADING_OPEN` in `lib/market/access.js` pull either back to the
testers list; the nav tab, the
pages and the API all ask that one function, and signed-out visitors get a
404 either way.

**Decoupled.** Everything lives in `lib/market/`, `app/market/`,
`app/api/market/` and `components/market/`, with its own stylesheet (`mk-`
classes, imported only by the Market layout) and its own test suite
(`npm run test:market`). It reads shared code -- `currentBettor`,
`fetchProjections`, `actualPoints`, `fractionRemaining`, `PlayerPhoto` -- and
changes none of it. The single touch on the rest of the app is one line in
`components/Nav.js` that mounts `MarketTab`, which renders nothing for anyone
off the list.

## Two price sources

`?source=live` (the default) and `?source=mock`, switched at the top of the
watchlist.

| | Mock | Live |
|---|---|---|
| Players | real, from this week's Sleeper projections | same |
| Price now | invented, moves with the clock | projection + Sleeper stat line, repriced in play |
| History | 90 days of minute prices, computed on demand | the tick log, from the day it was switched on |
| Purpose | see the chart work | see the real number |

### The mock engine (`lib/market/mock.js`)

Deterministic from the player id and the time: nothing is stored, so two
phones agree and a reload shows the same history, yet every minute brings a
new tick. Two layers:

- **Daily.** A random walk of closes, one per Eastern day, with 5% steps on
  game days (Sun, Mon, Thu), 1.2% steps otherwise, a 3% chance of a news jump,
  and a slow pull back toward the fundamental price.
- **Minute.** Inside each day, a noisy path bridged to land on that day's
  close. In the game window the noise is six times louder and touchdowns
  arrive as 1.5% to 6.5% jumps, mostly up.

Candles at any width are built by walking the minute path, so the 3M chart
and the 1D chart are the same numbers at different resolutions. The market
never closes, so a quote's change is against the price 24 hours ago, the way
crypto is quoted, rather than against a session close.

### The live price (`lib/market/price.js`)

Fundamental price is half the weekly projection: a 20-point stud is a
10-point share, a starter 5, a dart throw 2 (it was four times the projection
for the first Sunday; the tick log was rescaled by 1/8 on 2026-09-13). In play the price is "what will he finish with": points scored plus
what is still expected, and as the game goes on his own pace counts for up to
half of the estimate. At the final whistle the price is half his points.

### Prices carry between weeks (`lib/market/baselines.js`)

On top of half the projection every player carries a **premium**: what the
surprises of earlier weeks have added to or taken from him. At the roll (the
first tick after Sleeper flips the week, run by the per-minute cron) each
player's premium takes on the whole of last week's surprise in price terms
and then decays a quarter:

    premium_next = 0.75 × (premium + 0.5 × (actual − projection))

A 30-point week on a 20 projection finishes at 15 and opens the next week at
13.75 on the same projection: a step, not a cliff. A 10-point bust opens at
6.25. Old surprises fade over about a month, so a price cannot drift away
from the projection forever. Week 1 carries nothing. The roll also records
the week's **dividend** per share, 5% of the points (a 20-point week pays 1),
for when shares exist. `npm run test:marketroll` exercises the roll against a
sentinel season with injected feeds.

## The universe

Top 150 by projection across QB, RB, WR, TE and DEF, one Sleeper call, cached
ten minutes. Tickers are first initial plus three letters of the surname
(BROB, JCHA); a defence is its team plus D (SFD). Collisions are settled by
projection: the bigger name keeps the clean symbol.

## Ranges

| Range | Window | Candle |
|---|---|---|
| 1D | rolling 24 hours | 5 min |
| 1W | rolling 7 days | 1 hour |
| 2W | rolling 14 days | 2 hours |
| 1M | rolling 30 days | 6 hours |
| 2M | rolling 60 days | 12 hours |
| 3M | rolling 90 days | 1 day |

## What moves a real price (the plan)

Sunday, while the game is on: every fantasy point ticks the price; pace
against projection; kickoff lift and inactive drop; in-game injury; game
script; clock decay; the final whistle settles to the actual total; orders
fill on the next tick so nobody front-runs the feed.

During the week: rest-of-season projection; injury report; depth chart
moves; bye weeks; upcoming matchup (the FantasyPros defence ranks); Vegas
total if a lines feed is added.

Driven by the league: the market maker moves the price with every order;
Sleeper trades and waiver claims bump attention; benched players trade at a
discount.

## Next phases

1. **Tick log** -- done 2026-09-13 (`db/024_market_ticks.sql`,
   `lib/market/ticks.js`). One row per snapshot holding every price as JSON,
   written whenever the live board is loaded and the newest row is more than
   a minute old. About 1,400 rows a Sunday.
2. **Why it moved** -- done 2026-09-13 (`db/025_market_inputs.sql`,
   `lib/market/why.js`). Every tick also records the inputs behind each price
   (points, share of game left, projection, status). The stock page's "Why
   did it move" panel diffs consecutive ticks and names the cause of every
   move; a price that changed with no input change is flagged UNEXPLAINED.
   `/api/market/why?ticker=BROB&range=1D&format=csv` dumps the raw track.
   A per-minute Vercel cron (`/api/market/tick`, Pro plan) keeps the log
   gap-free: a tick a minute while any game is on, a quarter hour otherwise.
   Storage is about 8 KB a tick, a few MB a Sunday.
3. **Trading** -- built 2026-09-14 (`db/027_market_trading.sql`,
   `lib/market/trading.js`); opened to the whole league on 2026-09-15
   (`MARKET_TRADING_OPEN` in `access.js`). The rules, all enforced in `trading.js`:
   - **Spread 5%.** A buy fills at the ask (price x 1.025), a sell at the bid
     (price x 0.975). The gap is the points sink.
   - **Whole points.** The ledger is integers: a buy costs the ask rounded up,
     a sell pays the bid rounded down. Shares are whole.
   - **Cap 10 shares** of one player per owner, pending orders included. No
     league-wide supply: the price is the model's, not demand's.
   - **Orders fill at the next recorded tick**, never on the tap, so nobody
     trades on a touchdown before the feed sees it. Fills happen inside
     `liveBoard` right after `recordTick` writes, at that tick's prices, so
     every fill is auditable against the chart. Cancel while pending.
   - **Dividends** 5% of the week's points per share, paid at the roll by
     `payDividends`, one `point_ledger` row per owner per week (rounded down,
     `point_ledger_dividend_once`), detail in `market_dividends`.
   - Points move through the same ledger the shop spends from (`reason`
     'trade' and 'dividend'). A held player keeps a price after dropping out
     of the top 150 (`loadUniverse({ include })`).
   - Screens: the trade sheet on the stock page, `/market/portfolio`, "own N"
     on the watchlist. `npm run test:markettrade` covers the arithmetic,
     placement rules, fills, rejections and dividends in a sentinel season.
   - Not yet: demand moving the price (a market maker) and phase rules that
     freeze trading.
4. **Open trading up** -- done 2026-09-15.
