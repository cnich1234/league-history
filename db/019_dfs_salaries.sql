-- Daily fantasy salaries.
--
-- Sleeper has no salary field -- nothing salary-, price-, cost- or cap-like on
-- a player record -- so they are derived from the projections we already fetch
-- for the board:
--
--   salary = round100(FLOOR + projection x PER_POINT)
--
-- Stored rather than computed on the fly for one reason: a price somebody drafts
-- against must not move under them. Sleeper revises projections during the week,
-- and a lineup that was legal when it was built has to stay legal.
--
-- Keyed by week, so each week is priced from its own projections and the table
-- doubles as a record of what a player cost at the time.
create table if not exists dfs_salaries (
  season     integer not null,
  week       integer not null,
  player_id  text not null,
  name       text not null,
  position   text not null,
  nfl_team   text,
  projection numeric(6, 2) not null,
  salary     integer not null check (salary > 0),
  built_at   timestamptz not null default now(),
  primary key (season, week, player_id)
);

-- The lineup builder reads a whole week's pool at once, filtered by position.
create index if not exists dfs_salaries_week_idx
  on dfs_salaries (season, week, position);
