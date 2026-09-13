# The Market

A play stock market where every NFL player is a ticker. You buy shares with
points, watch the price move, and sell when you like. Phase 1 is the watchlist
and the chart; trading comes later.

**Hidden.** Only the slugs in `lib/market/access.js` see the nav tab, the pages
or the API. Everyone else gets a 404. Opening it to the league is one edit
there.

**Decoupled.** Everything lives in `lib/market/`, `app/market/`,
`app/api/market/` and `components/market/`, with its own stylesheet (`mk-`
classes, imported only by the Market layout) and its own test suite
(`npm run test:market`). It reads shared code -- `currentBettor`,
`fetchProjections`, `actualPoints`, `fractionRemaining`, `PlayerPhoto` -- and
changes none of it. The single touch on the rest of the app is one line in
`components/Nav.js` that mounts `MarketTab`, which renders nothing for anyone
off the list.

## Two price sources

`?source=mock` (the default) and `?source=live`, switched at the top of the
watchlist.

| | Mock | Live |
|---|---|---|
| Players | real, from this week's Sleeper projections | same |
| Price now | invented, moves with the clock | projection + Sleeper stat line, repriced in play |
| History | 90 days of minute prices, computed on demand | none yet |
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

Fundamental price is the weekly projection times four: a 20-point week is an
80 stock. In play the price is "what will he finish with": points scored plus
what is still expected, and as the game goes on his own pace counts for up to
half of the estimate. At the final whistle the price is his points times four.

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

1. **Tick log.** One row per snapshot holding every price as JSON, written
   lazily when a page is loaded during games and the last row is stale. Gives
   the live source a chart. About 1,300 rows a Sunday.
2. **Trading.** Shares, a small table of holdings, an automated market maker
   so buys push the price up and sells push it down, a spread as the points
   sink, a cap on shares per player, weekly dividends for holders, and phase
   rules for when trading freezes.
3. **Open it up.** Remove the testers gate.
