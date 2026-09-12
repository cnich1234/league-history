-- Half-finished lineups, saved as they are built.
--
-- A lineup took ten taps to assemble and vanished on a refresh, which is the
-- kind of thing that stops somebody bothering a second time.
--
-- Deliberately NOT stored in dfs_entries. An entry is a commitment: it holds a
-- valid, complete, cap-legal lineup, and entering a lobby charges the buy-in.
-- A draft is none of those things -- it is four players and an intention, and
-- writing it into dfs_entries would mean charging somebody points for half a
-- team, or loosening the validation that makes an entry mean something.
--
-- One draft per person per contest. Saving again replaces it: there is no
-- history worth keeping in a lineup somebody is still editing.
create table if not exists dfs_drafts (
  contest_id bigint not null references dfs_contests (id) on delete cascade,
  bettor     text not null references bettors (slug),
  slots      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (contest_id, bettor)
);
