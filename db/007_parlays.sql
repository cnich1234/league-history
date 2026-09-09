-- Parlays: several legs, all of which must win.
--
-- A parlay is one wager with many outcomes, so it is a row in `bets` like any
-- other -- same stake limits, same bankroll check, same ledger. The legs hang
-- off it. That means the existing settlement, standings and results code keeps
-- working without knowing parlays exist.
--
-- `market_id` and `option_key` become nullable because a parlay has no single
-- market. A partial unique index keeps the "one bet per market" rule for
-- straight bets, where it belongs, without blocking a parlay that touches a
-- market you also bet straight.

alter table bets alter column market_id drop not null;
alter table bets alter column option_key drop not null;
alter table bets add column if not exists is_parlay boolean not null default false;
-- Combined decimal odds, stored so a payout can never drift from what was shown
-- when the slip was placed.
alter table bets add column if not exists parlay_odds int;

-- The old constraint blocked a second bet on the same market. Parlays have a
-- null market_id, and Postgres treats nulls as distinct, so this would not have
-- blocked them -- but being explicit costs nothing and documents the intent.
alter table bets drop constraint if exists bets_bettor_market_id_key;
create unique index if not exists bets_one_straight_per_market
  on bets (bettor, market_id) where market_id is not null;

-- A straight bet must name a market; a parlay must not.
alter table bets drop constraint if exists bets_shape_check;
alter table bets add constraint bets_shape_check check (
  (is_parlay = false and market_id is not null and option_key is not null)
  or (is_parlay = true and market_id is null and option_key is null)
);

create table if not exists parlay_legs (
  bet_id      bigint not null references bets (id) on delete cascade,
  market_id   bigint not null references markets (id),
  option_key  text not null,
  -- Odds frozen per leg at placement, same reason as a straight bet.
  odds        int not null,
  status      text not null default 'pending'
              check (status in ('pending', 'won', 'lost', 'push', 'void')),
  settled_at  timestamptz,
  primary key (bet_id, market_id),
  foreign key (market_id, option_key) references market_options (market_id, option_key)
);

create index if not exists parlay_legs_market_idx on parlay_legs (market_id);
