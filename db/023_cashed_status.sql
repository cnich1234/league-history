-- Cash Out: a bet settled early, at what it was worth at the time.
--
-- Neither a win nor a loss nor a push. The bettor took a number the live model
-- offered and walked away before the result was known, so recording it as any
-- of those would misstate what happened -- 'won' would count it in a record
-- it never earned, 'push' would say the market tied. It gets its own word.
--
-- payout_cents holds the cash-out value. The stake half returns to the week it
-- came from and anything above it banks, exactly as a win splits.
alter table bets drop constraint if exists bets_status_check;
alter table bets add constraint bets_status_check
  check (status in ('pending', 'won', 'lost', 'push', 'void', 'cashed'));
