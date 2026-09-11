-- Collective bounties: the crowd buys the attack, nobody buys a boost.
--
-- The old model could not be priced. A hunter bought the weapon at list and
-- collected a reward, so they needed reward > cost while the poster needed
-- reward < cost or they would just buy it themselves. Those intervals never
-- overlap -- there were no gains from trade, because the hunter could do
-- nothing the poster could not do at the same price.
--
-- Here there is no hunter. A bounty names a target, a weapon and a bet, and
-- costs exactly what that weapon costs in the shop. Anyone chips in. When the
-- contributions reach the price the attack fires on its own and the bounty
-- closes. Nobody resells anything, so there is nothing to misprice.
alter table bounties add column if not exists bet_id bigint;
alter table bounties add column if not exists cost_points integer;
alter table bounties add column if not exists status text not null default 'open';
alter table bounties add column if not exists fired_at timestamptz;
alter table bounties add column if not exists closed_reason text;

-- reward_points was the poster's chosen number. Under this model the price is
-- the weapon's list cost, so the column is kept only for the rows that predate
-- the change and is no longer written.
alter table bounties alter column reward_points drop not null;

-- Who put in what. Separate rows rather than a running total on `bounties`, for
-- the same reason balances are derived everywhere else in this app: a stored
-- total drifts and nothing notices, a sum cannot.
create table if not exists bounty_contributions (
  id           bigserial primary key,
  bounty_id    bigint not null references bounties (id) on delete cascade,
  contributor  text not null,
  points       integer not null check (points > 0),
  created_at   timestamptz not null default now()
);

-- One row per person per bounty. Topping up adds to the existing row rather
-- than creating a second, so "split the payout by what each put in" has one
-- obvious answer per contributor.
create unique index if not exists bounty_contrib_one_per_person
  on bounty_contributions (bounty_id, contributor);

create index if not exists bounty_contrib_bounty_idx
  on bounty_contributions (bounty_id);

-- Open bounties are read on every board render, so keep that lookup cheap.
create index if not exists bounties_open_status_idx
  on bounties (season, week, status)
  where status = 'open';

-- The old unique index assumed one live bounty per (target, weapon). A bounty
-- now also names a BET, so the same weapon can sit on two different bets of the
-- same person -- which is a reasonable thing to want.
drop index if exists bounties_one_per_target_weapon;
create unique index if not exists bounties_one_per_target_weapon_bet
  on bounties (season, week, target, weapon, coalesce(bet_id, -1))
  where status = 'open';
