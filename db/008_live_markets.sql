-- Live betting on head-to-head and spread markets.
--
-- `live` marks a market that keeps taking bets after its normal lock, priced
-- from the current game state rather than the pregame line. Only h2h and
-- spread qualify: totals and props hinge on one lineup or one player, where a
-- partially-played market is far easier to pick off.
--
-- The pregame price stays in market_options and is what a bet gets before
-- kickoff. Once live, the price comes from the model on every request -- it is
-- deliberately NOT stored per-tick, because a stored price is a price someone
-- can bet after it goes stale.
alter table markets add column if not exists live boolean not null default false;

-- Which prices were actually offered, for after-the-fact checking. A bet's own
-- odds live on the bet; this is the audit trail for what the board showed.
create table if not exists live_quotes (
  market_id     bigint not null references markets (id) on delete cascade,
  quoted_at     timestamptz not null default now(),
  probability   numeric(6, 5) not null,
  option_key    text not null,
  odds          int not null,
  primary key (market_id, quoted_at, option_key)
);

create index if not exists live_quotes_market_idx on live_quotes (market_id, quoted_at desc);

-- Head-to-head and spread markets go live for the rest of the season.
update markets set live = true where kind in ('h2h', 'spread');
