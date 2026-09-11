-- Bounties: paying somebody else to do your dirty work.
--
-- Everything else in the shop is something you do TO someone. A bounty is the
-- only thing that makes another manager's move worth money to them, which is
-- why it is a table of its own rather than another row in `boosts`.
--
-- The reward is escrowed in point_ledger the moment it is posted. Without that
-- someone could advertise ten points, watch a claim land, and have nothing to
-- pay with -- and the claimer has already spent real points on the weapon by
-- the time they find out.
--
-- The weapon is NAMED. Hitting the right person the wrong way earns nothing.
-- That constraint is the whole game: it is what makes a bounty a request rather
-- than a bonus for whatever someone was going to do anyway.
create table if not exists bounties (
  id             bigserial primary key,
  season         integer not null,
  week           integer not null,
  poster         text not null,
  target         text not null,
  weapon         text not null,
  reward_points  integer not null check (reward_points > 0),
  posted_at      timestamptz not null default now(),
  claimed_by     text,
  claimed_at     timestamptz,
  claim_boost_id bigint,
  check (poster <> target)
);

-- One live bounty per (target, weapon) per week. Two people offering points for
-- the same hit would both pay for one attack, and the claim logic would have to
-- pick a winner arbitrarily. Once claimed the row stays but stops blocking, so
-- the same weapon can be put back on the same target next week.
create unique index if not exists bounties_one_per_target_weapon
  on bounties (season, week, target, weapon)
  where claimed_by is null;

create index if not exists bounties_open_idx
  on bounties (season, week)
  where claimed_by is null;

-- Claims look up "is there a bounty on this person" on every attack, so the
-- target leads.
create index if not exists bounties_target_idx
  on bounties (target, season, week);
