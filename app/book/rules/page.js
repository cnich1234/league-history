export const metadata = { title: 'House Rules' };

export default function RulesPage() {
  return (
    <>
      <p className="page-sub">How this works.</p>

      <section className="section">
        <div className="prose">
          <h2>The game</h2>
          <p>
            Everyone starts with <strong>$1,000</strong> in fake money. Bet on our own
            matchups all season. Whoever has the most money at the end wins{' '}
            <strong>$200</strong> in real money.
          </p>

          <h2>When bets lock</h2>
          <p>
            Every market closes at <strong>midnight Arizona time on the morning of the
            game</strong> — so a Sunday bet closes Saturday night, and a Thursday bet
            closes Wednesday night.
          </p>
          <p>
            A market closes as soon as <strong>any</strong> player it depends on takes the
            field. For a player prop that is just that player&apos;s game. For a matchup or
            a spread it is twenty starters, and one of them is usually in the Thursday
            game — so <strong>most matchups and spreads close Wednesday night</strong>.
            That is on purpose: once someone has already scored, betting the matchup
            is not really betting.
          </p>
          <p>
            Team totals and props usually stay open longer, since they depend on fewer
            players.
          </p>
          <p>
            Once a market <strong>closes</strong>, everyone&apos;s bets on it become public —
            that is the Floor at the bottom of the board. Before that nobody sees anyone
            else&apos;s picks. No copying, no tailing.
          </p>
          <p>
            A live market counts as closed only when it actually stops taking bets, not
            when its posted lock passes — otherwise you could see what someone took and
            still bet against it.
          </p>

          <h2>Limits</h2>
          <ul>
            <li>Minimum bet <strong>$10</strong>, maximum <strong>$250</strong></li>
            <li>One bet per market — no taking both sides</li>
            <li>No editing or cancelling once placed</li>
          </ul>

          <h2>What you can bet</h2>
          <ul>
            <li><strong>Head to head</strong> — who wins the matchup</li>
            <li><strong>Spread</strong> — does the favourite win by more than the line</li>
            <li><strong>Team total</strong> — over or under a team&apos;s projected score</li>
            <li><strong>Player props</strong> — over or under one starter&apos;s points</li>
          </ul>
          <p>
            Lines come from Sleeper&apos;s own weekly projections. Nobody sets them by hand.
          </p>

          <h2>Live betting</h2>
          <p>
            <strong>Matchups and spreads keep taking bets once games start.</strong> The
            price moves as points come in — a team down 30 on Sunday morning pays far more
            than they did on Wednesday.
          </p>
          <p>
            Each matchup shows a live <strong>win probability</strong>. The number accounts
            for how much is still left to play, not just the current score: a 30-point lead
            on Thursday night barely moves it, because 90% of the week has not happened yet.
          </p>
          <p>
            <strong>A matchup closes once one side reaches 90%.</strong> No fixed time — it
            depends on the games. Tied going into Monday night and it stays open to the end;
            up 40 on Sunday afternoon and it closes.
          </p>
          <p>
            Your odds lock when you bet. If the price moves while you are confirming, the bet
            is refused rather than filled at a worse number — check the new price and decide
            again.
          </p>
          <p>
            <strong>Team totals go live too.</strong> A total depends on one lineup, so it
            closes on that team&apos;s own progress — their side can be decided while their
            opponent still has players to play.
          </p>
          <p>
            Player props stay pregame. A single player&apos;s line is the easiest thing on
            the board to pick off once their game is underway.
          </p>
          <p>
            <strong>The maximum shrinks as a matchup gets decided.</strong> Full $250 while
            it is a real contest, then less as one side pulls clear — around $170 at 80%,
            $90 at 85%, down to the $10 minimum right before it closes at 90%. A $250 bet
            on a coin flip and a $250 bet on something already decided are not the same
            wager.
          </p>
          <p>
            Live prices carry a bigger house cut than pregame — about 9% against 4.5% —
            same as real sportsbooks. That gap is the price of betting on something already
            half-decided.
          </p>

          <h2>Parlays</h2>
          <p>
            Pick two or more legs and combine them into one bet. Every leg has to win.
            The odds multiply, so three coin-flips at -110 pays about <strong>+596</strong>{' '}
            — a $50 parlay returns close to $348.
          </p>
          <p>
            A parlay locks when its <strong>earliest</strong> leg does — unless that leg is
            a live market, in which case it stays available at the live price like any
            other bet. Player props still lock, so a prop leg does have to be in before
            that player&apos;s game.
          </p>
          <p>
            A parlay is capped by its tightest leg: if one leg is close to decided, the
            whole slip takes that leg&apos;s smaller maximum.
          </p>
          <p>
            If a leg is voided — a prop on someone who never played — that leg drops out
            and the rest are re-priced. A two-leg parlay with one dead leg becomes a
            straight bet on the survivor.
          </p>
          <p>Maximum six legs, and the usual $10–$250 stake limits apply.</p>

          <h2>Going broke</h2>
          <p>
            If you run out, a <strong>$20 buy-in</strong> gets you back to $1,000. The $20
            goes straight into the prize pool, so the pot grows every time someone busts.
            Ask Chris to set it up.
          </p>

          <h2>Settlement</h2>
          <p>
            Bets settle from Sleeper&apos;s final scores once the week is over. A tie
            refunds your stake. So does a <strong>void</strong> — a prop on a player who
            never started, for instance, where there was no way to win.
          </p>
          <p>
            Totals and spreads use half-point lines, so they can never push. Landing
            exactly on a whole-number line counts as <strong>under</strong>.
          </p>

          <h2>Odds</h2>
          <p>
            Standard American odds. <strong>-150</strong> means risk $150 to win $100;{' '}
            <strong>+200</strong> means risk $100 to win $200. The house takes a small cut
            on every line, so betting both sides of everything loses slowly.
          </p>
        </div>
      </section>
    </>
  );
}
