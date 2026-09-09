-- The Book: play-money sportsbook for the League of Extraordinary Gentlemen.
--
-- Design rules this schema enforces, rather than trusting application code:
--
--   1. A bet cannot be read by anyone but its owner until its market locks.
--      Enforced in the query layer, but `locks_at` lives here so the rule has a
--      single source of truth.
--   2. A bet cannot be edited or deleted after it is placed. There is no UPDATE
--      path for stake or selection -- only settlement writes to a bet.
--   3. A bankroll is never stored as a mutable number. It is derived from the
--      ledger, so a balance can always be explained by the rows that produced
--      it and can never silently drift.
--
-- Rule 3 is the important one. Storing `balance` and adjusting it on each bet
-- means one bad write corrupts the season with no way to detect it. Summing an
-- append-only ledger costs nothing at ten users and is always auditable.

create table if not exists bettors (
  slug          text primary key,          -- matches league.json owner slug
  display_name  text not null,
  -- Shared-password auth: fake money, ten friends who know each other. A real
  -- per-user credential is more security than this needs and more friction
  -- than anyone would tolerate.
  created_at    timestamptz not null default now()
);

-- A market is one thing you can bet on. Markets are created by a script from
-- Sleeper data, never by users.
create table if not exists markets (
  id            bigserial primary key,
  season        int not null,
  week          int not null,
  kind          text not null check (kind in ('h2h', 'total', 'spread', 'prop', 'futures')),
  -- Human-readable question, e.g. "Token Effort vs Seal Team Nix".
  title         text not null,
  subtitle      text,
  -- Betting closes here. Reads of other people's bets open at the same moment.
  locks_at      timestamptz not null,
  status        text not null default 'open'
                check (status in ('open', 'locked', 'settled', 'void')),
  -- Which selection won. Null until settled; set to the winning option key.
  winning_option text,
  settled_at    timestamptz,
  -- Everything needed to settle automatically: roster ids, the line, the
  -- player id for props. Shape varies by kind, so it is JSON rather than
  -- fifteen mostly-null columns.
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists markets_week_idx on markets (season, week, status);

-- The selections available on a market, with their price.
create table if not exists market_options (
  market_id     bigint not null references markets (id) on delete cascade,
  option_key    text not null,             -- 'home' | 'away' | 'over' | 'under' | ...
  label         text not null,
  -- American odds: -150 means risk 150 to win 100; +200 means risk 100 to win 200.
  odds          int not null,
  primary key (market_id, option_key)
);

create table if not exists bets (
  id            bigserial primary key,
  bettor        text not null references bettors (slug),
  market_id     bigint not null references markets (id),
  option_key    text not null,
  stake_cents   bigint not null check (stake_cents >= 1000 and stake_cents <= 25000),
  -- Odds are copied in at placement. A market's price may move afterwards, and
  -- a settled bet must pay what was agreed when it was struck.
  odds          int not null,
  placed_at     timestamptz not null default now(),
  status        text not null default 'pending'
                check (status in ('pending', 'won', 'lost', 'push', 'void')),
  payout_cents  bigint,                    -- total returned incl. stake; null until settled
  settled_at    timestamptz,
  foreign key (market_id, option_key) references market_options (market_id, option_key),
  -- One bet per person per market. Prevents hedging both sides of your own
  -- game, which is not interesting and is annoying to settle.
  unique (bettor, market_id)
);

create index if not exists bets_bettor_idx on bets (bettor, status);
create index if not exists bets_market_idx on bets (market_id);

-- Append-only money movement. Every row explains one change to a bankroll.
create table if not exists ledger (
  id            bigserial primary key,
  bettor        text not null references bettors (slug),
  -- Positive credits the bettor, negative debits.
  amount_cents  bigint not null,
  reason        text not null check (reason in ('seed', 'stake', 'payout', 'refund', 'adjustment')),
  bet_id        bigint references bets (id),
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists ledger_bettor_idx on ledger (bettor);

-- A settlement must never be applied twice. One payout row per bet, enforced
-- by the database rather than by remembering to check first.
create unique index if not exists ledger_one_payout_per_bet
  on ledger (bet_id, reason) where bet_id is not null;

-- Current standings. A view rather than a table, so it cannot disagree with
-- the ledger it summarises.
create or replace view bankrolls as
select
  b.slug,
  b.display_name,
  coalesce(sum(l.amount_cents), 0)                                         as balance_cents,
  coalesce(sum(l.amount_cents) filter (where l.reason = 'stake'), 0)       as staked_cents,
  count(distinct bet.id) filter (where bet.status = 'won')                 as wins,
  count(distinct bet.id) filter (where bet.status = 'lost')                as losses,
  count(distinct bet.id) filter (where bet.status = 'pending')             as pending
from bettors b
left join ledger l on l.bettor = b.slug
left join bets bet on bet.bettor = b.slug
group by b.slug, b.display_name;
