-- Positional showdowns: one manager's starters at a position against the
-- other's, with a handicap. Structurally a spread -- cover/nocover, half-point
-- line, same normal model -- but scoped to a position group, so it needs its
-- own kind for the resolver to know which players to compare.
--
-- Alternate ("blowout") spreads need no migration: they are ordinary spread
-- markets with a longer line and a priced-off-model number, distinguished only
-- by meta.alternate for display.

alter table markets drop constraint if exists markets_kind_check;
alter table markets add constraint markets_kind_check
  check (kind in ('h2h', 'total', 'spread', 'prop', 'futures', 'special', 'showdown'));
