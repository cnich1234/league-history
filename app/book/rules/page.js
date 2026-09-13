import { byKind, BOOSTS } from '@/lib/boosts';

/**
 * Prices come from the catalogue, never typed here. Every one of the eleven
 * on this page was stale after the shop was repriced -- Insurance read 12
 * while the store charged 36 -- and a rules page that disagrees with the
 * store is worse than no rules page.
 */
const cost = (kind) => byKind[kind].cost;
const cheapest = [...BOOSTS].sort((a, b) => a.cost - b.cost)[0];
const dearest = [...BOOSTS].sort((a, b) => b.cost - a.cost)[0];
export const metadata = { title: 'House Rules' };

export default function RulesPage() {
  return (
    <>
      <p className="page-sub">How this works.</p>

      <section className="section">
        <div className="prose">
          <h2>The game</h2>
          <p>
            <strong>$500 a week</strong> in fake money, which resets every week. Bet on
            our own matchups, bank what you win, and whoever has the most banked at the
            end takes <strong>$300</strong> in real money.
          </p>

          <h2>The Action</h2>
          <p>
            Every open bet in the league, live as soon as it is placed. You see{' '}
            <strong>who bet, how much, at what price and what it pays</strong> — and never
            what they backed.
          </p>
          <p>
            That is deliberate. A $250 bet at +600 is obviously the one worth hitting, but
            knowing it exists tells you nothing about which side it is on, so there is
            still no copying.
          </p>
          <p>
            It is also why <strong>attacks are cheap</strong>. You are guessing. Steal a bet
            that turns out to be a loser and the points bought you nothing at all.
          </p>
          <p>
            A bet showing 🛡️ is insured and cannot be touched. One showing 🎯 has already
            been hit by someone.
          </p>

          <h2>The money</h2>
          <p>
            <strong>$500 a week.</strong> It does not carry over — whatever is left when
            the week closes is gone.
          </p>
          <p>
            What survives is <strong>profit</strong>, which banks permanently. Win a $100
            bet at +200 and $200 goes in the bank. The <strong>stake is always
            consumed</strong>, win or lose. Most in the bank at the end of the season wins.
          </p>
          <p>
            The exception is a push or a void — a tie, or a prop on someone who never
            played. Those never really resolved, so the stake comes back into that week.
          </p>

          <h2>Two nastier attacks</h2>
          <p>
            <strong>🐌 Slow Play ({cost('slow-play')})</strong> doubles what their next bet costs. It comes
            out of their <em>allowance</em>, not their winnings — the only attack that
            makes someone poorer rather than shrinking a payout. They find out when they go
            to bet. Cheap, because it costs them nothing if they simply stop betting.
          </p>
          <p>
            Only a bet of <strong>$50 or more</strong> wears it off, parlays included.
            Anything smaller is charged normally and leaves the slow sitting there — so you
            cannot duck it with a $10 punt and carry on. That is the whole reason for the
            floor: without it a five-point attack costs $10 to cancel, and everyone would
            just open the week with a throwaway.
          </p>
          <p>
            It <strong>persists until it is worn off</strong>, including into the following
            week. Bet small all you like — it waits. And you are told: a slowed board says
            so at the top, and the bet slip shows the doubled cost before you confirm. It
            is a tax you can see coming, not a trap.
          </p>
          <p>
            <strong>🔀 Switcheroo ({cost('switcheroo')})</strong> moves one of their bets to a different
            option, and the price moves with it. On a two-sided market it flips. On a
            ten-way special it lands somewhere <em>random</em> — nine ways to be wrong.
            Completely blind, so it is as likely to rescue a dead bet as to kill a winner.
          </p>
          <p>
            It works on <strong>parlays</strong> too: one live leg is chosen at random and
            moved, which usually kills the slip outright, since every leg has to land.
            Legs that are already decided are left alone — only what is still live can be
            moved. A long parlay is not a hiding place.
          </p>

          <h2>One attack per bet</h2>
          <p>
            A bet takes <strong>one</strong> attack, whoever throws it. It used to be one
            of each kind, so three people could pile a Skim, a Void and a theft onto the
            same bet — which made the payout maths compose attacks that were never meant
            to stack. First one there gets it.
          </p>
          <p>
            Defences are separate: a bet can still carry an Insurance, a Mirror and a Half
            Again at the same time. It is only attacks that are one to a customer.
          </p>

          <h2>Taking a cut</h2>
          <p>
            <strong>🤝 Cut of the Action ({cost('tithe')})</strong> is the gentle end of the shop. It
            leaves the bet exactly where it is — they still win, they still bank — and
            simply pays you <strong>half the profit</strong>. Half the profit, not half the
            payout: their stake is never touched, so a win is still a win for them.
          </p>
          <p>
            A gamble, like Grand Theft: back a loser and you get nothing at all. Cheap
            because they barely feel it. Blocked by Insurance.
          </p>

          <h2>Putting points on someone</h2>
          <p>
            A <strong>🎯 Bounty</strong> is the one thing here that is not a boost. It buys
            you nothing. It pays somebody <em>else</em> to do the hitting: you name a
            target, name the weapon, and name the reward, and the first person to land
            exactly that attack on exactly that person collects.
          </p>
          <p>
            The weapon is <strong>named</strong>. A Void bounty pays for a Void — skimming
            them instead earns nothing, and the boost is still spent. That is the whole
            constraint: it makes a bounty a request rather than a tip for whatever someone
            was going to do anyway.
          </p>
          <p>
            The points <strong>leave your balance the moment you post</strong>, so an
            advertised reward is always real. You cannot collect your own. If nobody takes
            it by the end of the week it is refunded — nobody did the thing you asked for.
          </p>
          <p>
            An <strong>individual attack beats a bounty.</strong> If somebody pays out of
            their own pocket while the crowd is still raising, the bet has been hit and the
            bounty can never land — so it closes and everyone who chipped in is refunded.
            A bet that has already been attacked, or that is insured, cannot be bountied at
            all; it would not fire.
          </p>
          <p>
            It is <strong>public and loud</strong>, on The Action. That is the point: the
            target knows to buy Insurance, and everyone else knows there are points sitting
            on the table. A bounty on a mirrored bet still rebounds, and the claimer
            collects nothing.
          </p>

          <h2>Defending yourself</h2>
          <p>
            <strong>🛡️ Insurance ({cost('insurance')})</strong> absorbs a hit — a shielded bet ignores
            every attack. It is deliberately <em>dear</em>: it costs more than almost
            everything it blocks, so it goes on the one bet you would hate to lose rather
            than on all of them. At four points it was cheaper than being attacked, and
            shielding everything was simply the right move.
          </p>
          <p>
            <strong>🪞 Mirror ({cost('mirror')})</strong> returns a hit instead of absorbing it: whoever
            fires at a mirrored bet takes the same attack on their own biggest open bet,
            and they are told it happened. Cheaper than Insurance, because it only pays off
            if somebody actually comes for you.
          </p>
          <p>
            <strong>👻 Ghost ({cost('ghost')})</strong> takes a different line — your bets vanish from The
            Action for the week, so there is nothing to aim at. Cheap, but it is a whole
            week declared in advance, and people will notice you have gone quiet.
          </p>
          <p>
            <strong>🧾 Receipt ({cost('receipt')})</strong> names whoever attacked one of your bets. It
            changes no money at all. It just turns a hit into a grudge.
          </p>

          <h2>Managing a position</h2>
          <p>
            <strong>🎣 Hedge ({cost('hedge')})</strong> lets you back the other side of a market you are
            already on — normally one bet per market. The second one pays whatever the
            market costs <em>now</em>, which on a live market is a very different number
            from the one you got, so squaring off is never free. Both bets settle on their
            own merits.
          </p>
          <p>
            <strong>📌 Lock In ({cost('lock-in')})</strong> freezes a live price for you for half an hour.
            The number stops moving while you decide — for you only; everyone else is still
            betting the live market. Claim it by betting before the clock runs out or it
            expires unused. No real sportsbook offers this.
          </p>

          <h2>Getting out of a bet</h2>
          <p>
            Two ways, and they suit different moments.
          </p>
          <p>
            <strong>💸 Cash Out ({cost('cash-out')})</strong> settles a live bet early at whatever it is
            currently worth. Up on a position and want it banked before it turns? This.
          </p>
          <p>
            <strong>⏮️ Undo ({cost('undo')})</strong> voids the bet entirely and hands the whole stake
            back — any bet that has not settled, live ones included. Watching one die and
            want out? This. It is the dearest thing in the shop because it removes the
            risk completely, and an undone bet pays nothing even if the side you had
            backed goes on to win.
          </p>

          <h2>Better Price</h2>
          <p>
            If you own one, a tick-box appears when you pick a side. Tick it and the new
            odds and payout show immediately, before you confirm — so nothing is ever
            spent by accident.
          </p>
          <p>
            It boosts the <strong>profit</strong>, not the payout. +200 becomes +300, so
            $100 wins $300 instead of $200. That is weaker than it sounds on a favourite,
            which is why it is one of the cheapest things in the shop.
          </p>

          <h2>Two odd ones</h2>
          <p>
            <strong>🚗 Ride Along</strong> copies someone else&apos;s bet at their stake
            and their price. You never learn what it is — so it is a bet on the person,
            not the wager. They lose nothing; you both win or lose together.
          </p>
          <p>
            <strong>🖕 Because, Fuck You</strong> cuts 30% off everything one manager wins
            that week. Not one bet, all of them. Declared before the games, so you are
            guessing at their whole week.
          </p>

          <h2>Points and the store</h2>
          <p>
            Everything you do in the Trophy Room feeds The Book. Weekly achievements pay{' '}
            <strong>trophy points</strong>, and trophy points buy <strong>boosts</strong> —
            which change real money in here.
          </p>
          <p>
            Three sources now, near enough evenly: <strong>7 a week</strong> just for
            showing up, whatever your trophies earn, and whatever you place with in{' '}
            <strong>Daily</strong>. A typical manager ends the season with around{' '}
            <strong>300 points</strong> to spend.
          </p>
          <p>
            <strong>No achievement costs you points any more.</strong> Scoring the least in
            the league pays 2 as a consolation. There are four awards a manager who lost
            can still collect, so a bad season on the field does not lock you out of the
            store.
          </p>
          <p>
            Boosts run from <strong>{cheapest.cost}</strong> for {cheapest.name} to{' '}
            <strong>{dearest.cost}</strong> for {dearest.name}. The cheap ones protect and improve your own bets; the expensive ones go
            after everyone else, or undo your own mistakes. Buy them on the Store tab, use
            them from My Boosts.
          </p>
          <p>
            Buying is instant, but <strong>using</strong> a boost asks you to pick a target
            first — which of your bets to shield, which market to poison — and that choice
            cannot be undone.
          </p>

          <h2>Daily fantasy</h2>
          <p>
            One contest a week on the <strong>Daily</strong> tab, everybody in, no buy-in.
            Build a lineup under a <strong>$50,000</strong> cap — QB, RB, RB, WR, WR, TE,
            FLEX, DEF — and where you finish pays points into the same bank the store
            spends from: <strong>20</strong> for first, then 17, 13, 10, 8, 5, 3, 2, 1 and
            nothing for last.
          </p>
          <p>
            You can also open a <strong>lobby</strong>: name the seats and a buy-in, and
            the winner takes the pot. Those points are <em>recycled</em> rather than new —
            they move between managers and nothing is created — so a lobby can be as big
            as you like without inflating anything. If a lobby never fills, everybody gets
            their buy-in back.
          </p>
          <p>
            Lineups lock <strong>per player</strong>, not all at once. You can keep editing
            while everybody in your lineup is still to play; the moment one of them kicks
            off, the whole lineup is frozen. Picks save as you make them, so a refresh
            costs you nothing.
          </p>

          <h2>Where the prices come from</h2>
          <p>
            Salaries are worked out from <strong>Sleeper&apos;s own projections</strong>,
            re-scored under <em>this league&apos;s</em> rules — which matters more than it
            sounds. We pay <strong>6 for a passing touchdown</strong> where most daily
            fantasy sites pay 4, so pocket passers are worth more here and rushing
            quarterbacks less.
          </p>
          <p>
            That means <strong>our board will not match DraftKings</strong>, and it is not
            meant to. Comparing week 1 quarterbacks, the two orders agree only loosely:
            Baker Mayfield and Cam Ward sit far higher for us, Jayden Daniels and Josh
            Allen far lower. Some of that is our scoring; most of it is Sleeper and
            DraftKings simply disagreeing about football, and the rest is that their prices
            fold in Vegas totals and ownership guesses that we have no access to.
          </p>
          <p>
            So do not import somebody else&apos;s rankings and expect them to line up — a
            board built on standard scoring will <strong>overrate rushing quarterbacks</strong>{' '}
            in this league. And a price is only as good as the projection behind it, which
            is the whole game: the edge is spotting where Sleeper has somebody wrong.
          </p>
          <p>
            Anybody projected under <strong>4 points</strong> is left off the board
            entirely. They are not cheap options, they are players who will not score, and
            listing them only buries the real value picks.
          </p>

          <h2>Position battles</h2>
          <p>
            Your starters at one position against your opponent&apos;s, with a handicap —
            <strong>your WRs vs his WRs +5.5</strong>. QB, RB, WR and TE for every
            matchup.
          </p>
          <p>
            Only <strong>starters</strong> count, so a monster game on your bench does
            nothing. If either side started nobody at that position the bet is voided and
            you get your money back — there was never a bet to win.
          </p>

          <h2>Blowout lines</h2>
          <p>
            <strong>Does either team win by more than 20.5?</strong> (and 30.5). One
            market per matchup with both managers as options — back whoever you think
            is getting run off the field.
          </p>
          <p>
            <strong>A close game loses both sides.</strong> That is the catch, and it is
            why both can pay plus money: a game inside the line is the most likely
            result by far — roughly 40% of the time at 20.5, and 55% at 30.5 — and it
            pays nothing to anyone.
          </p>
          <p>
            Prices come from the same model as everything else, so a lopsided matchup
            pays less. A heavy favourite to win by 20+ might be <strong>-110</strong>,
            while the underdog doing it is <strong>+542</strong>.
          </p>

          <h2>Special bets</h2>
          <p>
            Four league-wide markets each week: <strong>highest scoring team</strong>,
            and the best starting <strong>RB</strong>, <strong>WR</strong> and{' '}
            <strong>TE</strong> in the whole league.
          </p>
          <p>
            These are <strong>team bets</strong>. You pick a manager, not a player — if
            your guy&apos;s starting RB tops the league that week, that bet wins. Only
            starters count; a monster game on someone&apos;s bench does not count for
            anyone.
          </p>
          <p>
            They involve every lineup in the league, so they lock at the{' '}
            <strong>first kickoff of the week</strong>. A tie pushes and everyone gets
            their money back.
          </p>

          <h2>When bets lock</h2>
          <p>
            <strong>Only player props close on the clock</strong>, and only when that
            player&apos;s own game kicks off. Bet a Monday night receiver on Sunday evening
            and it is still open.
          </p>
          <p>
            Everything else — matchups, spreads, team totals — <strong>never closes on
            time at all</strong>. Once the games start, the price moves with the score
            instead. A matchup with one Thursday starter stays bettable all weekend; it
            just gets more expensive to back the side that is winning.
          </p>
          <p>
            Those markets close when the result is no longer in doubt — at{' '}
            <strong>90%</strong> — or when the games are simply over. That is the whole
            point of live betting: nothing gets shut early just because the calendar
            says so.
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
            <li>
              <strong>Player props</strong> — over or under one player&apos;s points, for
              <em>every</em> skill player on a roster, bench included. A bench prop settles
              on what they actually scored, so backing somebody&apos;s benched sleeper is a
              real bet. Anyone projected under 3 is left off: at that line the bet is
              whether they dressed, not football.
            </li>
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
            A parlay is available as long as every leg is. Live legs stay open and get
            priced live, exactly like a straight bet. A <strong>prop</strong> leg is the
            one that can shut the slip, since props close at their player&apos;s kickoff —
            so get prop legs in before that game starts.
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
