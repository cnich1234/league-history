-- Why a price is what it is.
--
-- A price is a pure function of four inputs: projection, points scored, share
-- of the game left, and game status. Recording them beside the price means any
-- move can be explained afterwards by diffing two ticks, which is the whole of
-- debugging a market. Shape: { player_id: [points, remaining, projection, status] }
-- with status one of pre, live, final, none. Nullable so old rows still read.
alter table market_ticks add column if not exists inputs jsonb;
