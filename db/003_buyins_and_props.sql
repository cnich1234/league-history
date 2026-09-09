-- Re-ups and the real-money prize pool.
--
-- A re-up is the one place real and play money touch, and they are deliberately
-- kept in separate tables. The ledger is play money only -- it answers "who is
-- winning". `buyins` is real money -- it answers "how much is in the pot and who
-- still owes me twenty bucks". Putting both in the ledger would make a manager
-- who re-upped four times look like the season leader.

create table if not exists buyins (
  id              bigserial primary key,
  bettor          text not null references bettors (slug),
  season          int not null,
  -- Real money owed to the pot, in cents. The default is the $20 house rule,
  -- overridable in case a buy-in amount is ever changed mid-season.
  amount_cents    bigint not null default 2000 check (amount_cents > 0),
  -- Play money credited back to the bankroll in exchange.
  bankroll_cents  bigint not null check (bankroll_cents > 0),
  -- Whether the real cash actually landed. Approving a re-up and collecting
  -- for it are different events and often days apart.
  collected       boolean not null default false,
  collected_at    timestamptz,
  note            text,
  created_at      timestamptz not null default now()
);

create index if not exists buyins_season_idx on buyins (season, bettor);

-- The real prize pool: base pot plus every collected buy-in.
create or replace view prize_pool as
select
  season,
  count(*) filter (where collected)                                    as buyins_collected,
  count(*) filter (where not collected)                                as buyins_outstanding,
  coalesce(sum(amount_cents) filter (where collected), 0)              as collected_cents,
  coalesce(sum(amount_cents) filter (where not collected), 0)          as outstanding_cents
from buyins
group by season;

-- Props need a player and a line. Both live in markets.meta, but the settler
-- has to find open props quickly on gameday, so index the discriminator.
create index if not exists markets_kind_idx on markets (kind, status);

-- Longshot/futures betting is out of scope for now: settling a season-long
-- market correctly is a different problem from settling a week. The 'futures'
-- kind stays in the check constraint so removing it later is not a migration,
-- but nothing generates them.
comment on column markets.kind is
  'h2h | total | spread | prop. futures is reserved and unused.';
