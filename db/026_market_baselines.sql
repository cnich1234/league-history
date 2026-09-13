-- Prices carry between weeks.
--
-- A player's price is half his projection plus a PREMIUM: what the league's
-- surprises have added to (or taken from) him so far. At the week's roll the
-- premium takes on the whole of last week's surprise and then decays a
-- quarter, so a run of big weeks builds a price up over time and a bust
-- stays priced in until he earns it back, while nothing drifts off forever.
-- One row per player per week, written once by the roll; the week's dividend
-- (a slice of his points per share) is recorded here for when shares exist.
create table if not exists market_baselines (
  season          int  not null,
  week            int  not null,
  player_id       text not null,
  premium         numeric(10, 2) not null default 0,
  dividend        numeric(10, 2) not null default 0,
  prev_actual     numeric(10, 2),
  prev_projection numeric(10, 2),
  created_at      timestamptz not null default now(),
  primary key (season, week, player_id)
);
