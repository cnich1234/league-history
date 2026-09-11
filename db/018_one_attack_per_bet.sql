-- One attack per bet, not one of each kind.
--
-- boosts_one_per_bet_kind was unique on (target_bet_id, kind), which stopped
-- two Skims on one bet but happily allowed a Skim AND a Void AND a Grand Theft.
-- Three people could pile onto the same bet, and the payout maths had to
-- compose attacks that were never designed to stack.
--
-- A bet now takes one attack, full stop. Defensive and self boosts are
-- unaffected: Insurance, Mirror, Half Again and the rest are not attacks, and
-- a bet still needs to be able to carry a shield and a boost at once.
--
-- The partial index does the work. `is_attack` cannot be read from the
-- catalogue in SQL, so the attack kinds are listed here; adding an attack to
-- lib/boosts.js means adding it here too.
drop index if exists boosts_one_per_bet_kind;

create unique index if not exists boosts_one_attack_per_bet
  on boosts (target_bet_id)
  where target_bet_id is not null
    and kind in ('payout-cut', 'steal', 'blind-sabotage', 'void', 'switcheroo', 'tithe');

-- Non-attacks keep the old rule: one of each kind, so a bet cannot carry two
-- Insurances but can carry an Insurance and a Half Again.
create unique index if not exists boosts_one_per_bet_kind_nonattack
  on boosts (target_bet_id, kind)
  where target_bet_id is not null
    and kind not in ('payout-cut', 'steal', 'blind-sabotage', 'void', 'switcheroo', 'tithe');
