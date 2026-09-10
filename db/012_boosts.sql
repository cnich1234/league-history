-- Points and boosts: the Trophy Room becomes currency.
--
-- Points follow the same discipline as money -- an append-only ledger with the
-- balance as a derived view, never a stored number. The reason is the same one
-- that made the money ledger right: a stored balance can drift from its history
-- and nothing catches it, while a sum cannot.
--
-- Weekly allowance and trophy earnings are both just credits with a reason, so
-- "where did my points come from" is answerable by reading rows.

create table if not exists point_ledger (
  id          bigserial primary key,
  bettor      text not null references bettors(slug),
  season      int not null,
  -- Which week the points relate to. The weekly allowance is granted once per
  -- (bettor, season, week), enforced by the unique index below.
  week        int,
  amount      int not null,
  -- 'allowance' | 'trophies' | 'purchase' | 'refund' | 'adjustment'
  reason      text not null,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists point_ledger_bettor_idx on point_ledger (bettor, season);

-- One allowance per manager per week, however many times the grant runs.
create unique index if not exists point_ledger_allowance_once
  on point_ledger (bettor, season, week)
  where reason = 'allowance';

-- Trophy points are granted once per week too, from that week's scoring.
create unique index if not exists point_ledger_trophies_once
  on point_ledger (bettor, season, week)
  where reason = 'trophies';

create or replace view point_balances as
  select b.slug,
         b.display_name,
         coalesce(sum(p.amount), 0)::int as points
  from bettors b
  left join point_ledger p on p.bettor = b.slug
  group by b.slug, b.display_name;

-- A purchased boost, from bought to spent.
--
-- Bought and used are separate events on purpose: you buy insurance now and
-- attach it to a bet later, and an unused boost is still an asset. `target_*`
-- is null until it is applied.
create table if not exists boosts (
  id            bigserial primary key,
  owner         text not null references bettors(slug),
  season        int not null,
  kind          text not null,
  cost_points   int not null,
  bought_at     timestamptz not null default now(),

  -- What it was used on. Exactly one of these, depending on the kind.
  target_bet_id bigint references bets(id),
  target_market_id bigint references markets(id),
  target_bettor text references bettors(slug),

  used_at       timestamptz,
  -- Free-form per kind: the multiplier applied, the cash-out price taken, etc.
  -- Kept so a settled bet can explain its own number months later.
  detail        jsonb not null default '{}'::jsonb
);

create index if not exists boosts_owner_idx on boosts (owner, season);
create index if not exists boosts_target_bet_idx on boosts (target_bet_id);
create index if not exists boosts_target_market_idx on boosts (target_market_id);

-- A bet carries at most one payout-altering boost of each kind, or the maths
-- stops being explainable. Attack and defence are separate rows, so this does
-- not stop someone shielding a bet that was also boosted.
create unique index if not exists boosts_one_per_bet_kind
  on boosts (target_bet_id, kind)
  where target_bet_id is not null;
