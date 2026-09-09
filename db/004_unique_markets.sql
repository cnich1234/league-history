-- One market per (season, week, kind, title). The build script already checks
-- before inserting, but that check is a read followed by a write -- two runs
-- overlapping would both see "not there" and both insert. Odds must never
-- differ between duplicate copies of the same market, so the database enforces
-- it rather than trusting the script to be run one at a time.
create unique index if not exists markets_unique_idx
  on markets (season, week, kind, title);
