-- Allow a bet to be voided.
--
-- A void is not a loss and not a push: it is a market that could not be decided
-- fairly at all -- a prop on a player who was benched and never took the field,
-- for instance. The stake comes back, but recording it as a push would hide
-- that the market was broken rather than tied.
alter table bets drop constraint if exists bets_status_check;
alter table bets add constraint bets_status_check
  check (status in ('pending', 'won', 'lost', 'push', 'void'));
