-- Trading in The Market.
--
-- Shares are whole, prices are points to two decimals, and the points ledger
-- is whole points: a buy costs the ask rounded UP, a sell pays the bid rounded
-- DOWN. Orders do not fill on the tap; they queue and fill at the next
-- recorded tick, so nobody can trade on a touchdown before the feed sees it.
-- Dividends are paid at the week's roll, one ledger row per owner per week.

create table if not exists market_holdings (
  owner       text not null references bettors(slug),
  season      int  not null,
  player_id   text not null,
  shares      int  not null check (shares >= 0),
  cost_points int  not null default 0,   -- what the shares held cost, in whole points
  updated_at  timestamptz not null default now(),
  primary key (owner, season, player_id)
);

create table if not exists market_orders (
  id         bigserial primary key,
  owner      text not null references bettors(slug),
  season     int  not null,
  week       int  not null,
  player_id  text not null,
  side       text not null check (side in ('buy', 'sell')),
  shares     int  not null check (shares > 0),
  status     text not null default 'pending'
             check (status in ('pending', 'filling', 'filled', 'cancelled', 'rejected')),
  placed_at  timestamptz not null default now(),
  filled_at  timestamptz,
  price      numeric(10, 2),   -- the tick price it filled at
  points     int,              -- whole points moved: negative for a buy, positive for a sell
  note       text
);
create index if not exists market_orders_pending on market_orders (status, placed_at) where status = 'pending';
create index if not exists market_orders_owner on market_orders (owner, season, placed_at desc);

create table if not exists market_dividends (
  owner      text not null references bettors(slug),
  season     int  not null,
  week       int  not null,
  player_id  text not null,
  shares     int  not null,
  actual     numeric(10, 2) not null,   -- the week's points the dividend was on
  points     numeric(10, 2) not null,   -- shares x dividend per share, before rounding
  created_at timestamptz not null default now(),
  primary key (owner, season, week, player_id)
);

-- One dividend payout per owner per week, however many times the roll runs.
create unique index if not exists point_ledger_dividend_once
  on point_ledger (bettor, season, week) where reason = 'dividend';
