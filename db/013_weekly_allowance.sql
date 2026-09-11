-- Weekly allowance replaces the season-long bankroll.
--
-- Everyone gets $500 at the start of each week. It does NOT carry over: what is
-- left when the week closes is simply gone. What survives is PROFIT -- the
-- amount a winning bet returned above its stake -- which banks permanently.
-- Most in the bank at the end of the season wins.
--
-- Why profit rather than the whole return: with a weekly reset, losing a bet
-- costs nothing, because the allowance comes back regardless. If the full
-- return banked, the optimal play would be to put all $500 on the shortest
-- favourite every week -- a -300 shot banks $667 at almost no risk, and the
-- season goes to whoever bet the most rather than whoever bet best. Banking
-- only the profit keeps the same bet worth $167, which is what it should be.
--
-- The ledger gains a `week`. Rows scoped to a week are the spendable side;
-- rows with a null week are the bank.

alter table ledger add column if not exists week int;
create index if not exists ledger_week_idx on ledger (bettor, week);

-- One allowance per bettor per week, so a cron that fires twice cannot pay twice.
create unique index if not exists ledger_allowance_once
  on ledger (bettor, week) where reason = 'allowance';

-- Spendable this week: the allowance, less stakes, plus anything refunded.
-- Deliberately NOT including payouts -- a winning bet's stake and profit both
-- leave the week, the stake back into the week's pool and the profit into the
-- bank. See lib/book.js settleMarket for where that split is written.
create or replace view weekly_balances as
  select b.slug,
         b.display_name,
         l.week,
         coalesce(sum(l.amount_cents), 0)::bigint as balance_cents
  from bettors b
  join ledger l on l.bettor = b.slug and l.week is not null
  group by b.slug, b.display_name, l.week;

-- The bank: profit booked from settled bets, plus any adjustment. This is the
-- season-long number the prize is decided on.
create or replace view banks as
  select b.slug,
         b.display_name,
         coalesce(sum(l.amount_cents) filter (where l.week is null), 0)::bigint as bank_cents
  from bettors b
  left join ledger l on l.bettor = b.slug
  group by b.slug, b.display_name;

-- Two new reasons. 'allowance' is the weekly credit; 'stake-return' is the
-- stake half of a winning bet going back to the week it was bet from, which is
-- distinct from a refund because the bet was won rather than voided.
alter table ledger drop constraint if exists ledger_reason_check;
alter table ledger add constraint ledger_reason_check
  check (reason in ('seed', 'stake', 'payout', 'refund', 'buyin', 'adjustment',
                    'allowance', 'stake-return'));

-- The per-bet cap was $250: a quarter of the old $1,000 season bankroll.
-- Against a $500 week that would have been half the allowance in one bet, so
-- the allowance is the cap now and nothing sits below it. Live markets still
-- taper further as a result becomes decided -- that limit is about certainty,
-- not affordability.
alter table bets drop constraint if exists bets_stake_cents_check;
alter table bets add constraint bets_stake_cents_check
  check (stake_cents >= 1000 and stake_cents <= 50000);
