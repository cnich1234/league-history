# The Book — season-long betting for the League

A play-money sportsbook built into the league site. Everyone gets a bankroll,
bets on our own games all season, and whoever finishes with the most money wins
a real $100.

## How it works

**Everyone starts with $1,000** in fake money on day one. No buy-in, no top-ups.
When it's gone, it's gone — so a Week 3 blowup means fourteen weeks of scraping
back, which is the whole point.

**You bet on our league's games**, not the NFL. Every line comes from our own
matchups, so you're betting on people you talk to every day.

**Bets stay hidden until kickoff.** Nobody sees anyone else's picks until games
start Sunday. No copying, no tailing the guy who actually watches film. Once
kickoff hits, every bet in the league goes public — so the receipts are
permanent and the group chat has something to work with.

**Most money on the last week of the season wins $100.**

## What you can bet on

- **Head to head** — pick the winner. Underdogs pay more.
- **Over/under** — will a team beat their projected total?
- **Spread** — Team X beats Team Y by at least N points.
- **Player props** — will a specific starter clear a points line?
- **Longshots** — season-long bets at long odds. Who wins it all, who finishes
  last, who misses the playoffs.

Odds move with the matchup. Beating a 1-6 team pays almost nothing; picking the
upset pays real money.

## Rules that matter

- **Minimum bet $10, maximum $250 on a single wager** — so nobody dumps their
  whole bankroll on one game in Week 1 and spends the season at zero.
- **Bets lock at kickoff.** No editing, no cancelling once the first game
  starts.
- **Bankrupt is bankrupt.** No reloads. Play the season out.
- **Bets are permanent and public after lock.** Every pick you make is on the
  record forever, and the recap bot will absolutely use them against you.

## Why this is good

The league has ten people but only five games a week, and by November half of us
are eliminated and bored. This gives everyone a reason to care about every game
— including the ones they're not playing in, and especially the ones that don't
matter to the standings.

It also generates its own trash talk. The bot already writes the recaps. Once it
can see that Chad bet $200 against the guy who then dropped 180 on him, the
recaps write themselves.

## Open questions for the group

1. **Is $100 the right prize?** Ten people, one winner, whole season.
2. **Should there be a consolation prize** — biggest single win, or worst beat?
3. **Do we want player props at all?** They're the most fun and the most work to
   settle correctly.
4. **What happens if someone goes bankrupt in Week 5?** Sit out and watch, or
   some kind of re-entry?
5. **Should longshot season bets lock in Week 1**, or stay open all year at
   worsening odds?

## What it takes to build

Straight talk: this is a real build, not a weekend.

Everything on the site today is public, read-only data, which is why it runs free
with no server. Betting needs three things none of that required — a login for
each person, private bets that stay hidden until kickoff, and a ledger nobody can
quietly edit after the fact. That means a database and real accounts.

It's very doable. It's just the difference between a site that reads data and a
site that keeps score. Worth knowing before anyone picks a date.
