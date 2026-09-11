-- Hedge: a second bet on the OTHER side of a market you are already on.
--
-- The old index was one bet per (bettor, market) unconditionally, which made a
-- hedge impossible at the database level -- so lifting the application check
-- alone was not enough, and the insert failed with a constraint violation.
--
-- One bet per SIDE is the rule that actually matters. It still stops anyone
-- backing the same side twice to dodge the stake cap, which is what the
-- original constraint was really protecting against. Whether you may take the
-- opposite side is an application decision, and it costs a Hedge.
drop index if exists bets_one_straight_per_market;
create unique index if not exists bets_one_per_side
  on bets (bettor, market_id, option_key)
  where market_id is not null;
