-- League-wide "best in the league this week" markets.
--
-- Unlike every other kind these belong to no matchup: one market for the whole
-- league with one option per manager, rather than two sides of one game. The
-- option key is a roster id, which is why market_options.option_key stays free
-- text rather than an enum.
--
-- They are team bets. If your roster started the league's top RB that week,
-- your option wins.

alter table markets drop constraint if exists markets_kind_check;
alter table markets add constraint markets_kind_check
  check (kind in ('h2h', 'total', 'spread', 'prop', 'futures', 'special'));

-- Not live. A ten-way field has no two-sided price to move, and the live model
-- prices a margin between two outcomes -- there is nothing sensible for it to
-- quote here. These lock at the week's first kickoff and settle from final
-- scores like a prop.
