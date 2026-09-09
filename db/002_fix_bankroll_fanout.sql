-- The bankrolls view joined `ledger` and `bets` in the same query, so every
-- ledger row was duplicated once per bet and the sum was multiplied by the
-- bet count. A bettor with one $1,000 seed and three bets reported $3,000.
--
-- The join was silent and wrong in the direction that matters: it invented
-- money. Aggregating each table separately before joining removes the fan-out.

create or replace view bankrolls as
with money as (
  select bettor,
         coalesce(sum(amount_cents), 0)                            as balance_cents,
         coalesce(sum(amount_cents) filter (where reason = 'stake'), 0) as staked_cents
  from ledger
  group by bettor
),
records as (
  select bettor,
         count(*) filter (where status = 'won')     as wins,
         count(*) filter (where status = 'lost')    as losses,
         count(*) filter (where status = 'pending') as pending
  from bets
  group by bettor
)
select
  b.slug,
  b.display_name,
  coalesce(m.balance_cents, 0) as balance_cents,
  coalesce(m.staked_cents, 0)  as staked_cents,
  coalesce(r.wins, 0)          as wins,
  coalesce(r.losses, 0)        as losses,
  coalesce(r.pending, 0)       as pending
from bettors b
left join money m   on m.bettor = b.slug
left join records r on r.bettor = b.slug;
