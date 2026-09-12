-- Weekly defence rankings, for the "who are they playing" line on a player card.
--
-- A salary says what a player costs and a projection says what he is expected
-- to do, but neither says whether he is facing the best defence in the league
-- or the worst. That is the single most useful thing to know when two players
-- cost the same.
--
-- Sourced from FantasyPros consensus rankings, which rank all 32 defences for a
-- given week and name the opponent each is facing -- so one request gives both
-- the ranking and the fixture.
--
-- Stored per week rather than fetched on render: the lineup builder shows a
-- pool of ~460 players, and a per-render fetch would be one API call per page
-- view against a rate-limited key.
create table if not exists defense_ranks (
  season     integer not null,
  week       integer not null,
  team       text not null,
  rank_ave   numeric(5, 2),
  rank_ecr   integer,
  opponent   text,
  fetched_at timestamptz not null default now(),
  primary key (season, week, team)
);

-- The builder joins this against a whole week's pool at once.
create index if not exists defense_ranks_week_idx
  on defense_ranks (season, week);
