-- A payout can now be split between several people, so it needs more than one
-- ledger row per bet.
--
-- ledger_one_payout_per_bet was unique on (bet_id, reason): settle a bet twice
-- and the second insert conflicts instead of paying again. That was right while
-- exactly one person could ever be paid for a bet.
--
-- Two things broke it. A crowd-funded Grand Theft splits the stolen payout
-- between everyone who funded the bounty, and Cut of the Action pays a share of
-- the profit to the attacker while the owner banks the rest. Both write several
-- 'payout' rows against one bet.
--
-- Adding the bettor keeps the protection that actually matters -- the same
-- person still cannot be paid twice for the same bet, so a re-run of settlement
-- conflicts exactly as before -- while letting a payout be shared.
drop index if exists ledger_one_payout_per_bet;
create unique index if not exists ledger_one_payout_per_bet_per_bettor
  on ledger (bet_id, reason, bettor)
  where bet_id is not null;
