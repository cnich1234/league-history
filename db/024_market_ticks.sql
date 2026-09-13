-- The Market's tick log: where every stock traded, once a minute at most.
--
-- One row per snapshot holding every price as JSON, rather than a row per
-- player per tick. A Sunday of minute ticks is ~1,400 rows this way and a
-- couple of hundred thousand the other way, and a chart for one player is a
-- single key pulled out of each row. Rows are written lazily: whenever the
-- live board is loaded and the newest row is older than a minute.
create table if not exists market_ticks (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  prices jsonb not null
);
create index if not exists market_ticks_ts on market_ticks (ts);
