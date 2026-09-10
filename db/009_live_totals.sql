-- Team totals join head-to-head and spreads as live markets.
--
-- A total depends on one lineup rather than two, so it is suspended on that
-- team's own remaining share: a team with everyone finished is decided even
-- while their opponent still has players to play.
--
-- Props stay pregame. A single player's line is the easiest thing on the board
-- to pick off once their game is underway.
update markets set live = true where kind = 'total';
