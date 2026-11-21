-- How many rounds a player answered right, out of how many the game served.
-- The genre board shows it next to the score. Rows written before this
-- migration keep NULL and show the score alone.
ALTER TABLE game_results ADD COLUMN correct INTEGER;
ALTER TABLE game_results ADD COLUMN rounds INTEGER;
