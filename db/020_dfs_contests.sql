-- Daily fantasy contests and the lineups entered into them.
--
-- Two kinds, and the difference is where the points come from:
--
--   'weekly'  one a week, everyone in, no buy-in. Finishing position MINTS
--             points: 20/17/13/10/8/5/3/2/1/0.
--   'lobby'   anyone opens one, names the seats and the buy-in. Buy-ins are
--             escrowed and pooled, winner takes it. Nothing is minted -- points
--             move between managers and the total is unchanged.
--
-- The same table holds both because everything else about them is identical: a
-- field of lineups, locked at a kickoff, scored off Sleeper, settled once.
create table if not exists dfs_contests (
  id           bigserial primary key,
  season       integer not null,
  week         integer not null,
  kind         text not null check (kind in ('weekly', 'lobby')),
  name         text,
  host         text references bettors (slug),
  seats        integer check (seats is null or seats between 2 and 10),
  buyin_points integer not null default 0 check (buyin_points >= 0),
  status       text not null default 'open'
               check (status in ('open', 'locked', 'settled', 'void')),
  locks_at     timestamptz,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz,
  -- A weekly has no host and no buy-in; a lobby has both.
  check (kind = 'lobby' or (host is null and buyin_points = 0)),
  check (kind = 'weekly' or (host is not null and seats is not null))
);

-- One weekly per week. A second would split the field and mint twice.
create unique index if not exists dfs_one_weekly_per_week
  on dfs_contests (season, week)
  where kind = 'weekly';

create index if not exists dfs_contests_open_idx
  on dfs_contests (season, week, status);

-- A lineup. The players live in `slots` as jsonb rather than ten columns,
-- because the lineup shape is defined in lib/dfs.js and a schema that repeats
-- it is a second place to change when FLEX rules move.
create table if not exists dfs_entries (
  id          bigserial primary key,
  contest_id  bigint not null references dfs_contests (id) on delete cascade,
  season      integer not null,
  week        integer not null,
  bettor      text not null references bettors (slug),
  slots       jsonb not null,
  salary_used integer not null default 0,
  points      numeric(7, 2),
  place       integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One lineup per manager per contest. Editing updates it rather than adding a
-- second, which is also what stops somebody entering a lobby twice to double
-- their odds of taking the pot.
create unique index if not exists dfs_one_entry_per_contest
  on dfs_entries (contest_id, bettor);

create index if not exists dfs_entries_week_idx
  on dfs_entries (season, week, bettor);
