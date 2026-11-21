-- One row per game, guests included, written when the game begins. The
-- rounds it played are the round_outcomes rows with its game_id, so the end,
-- the players who quit and the gap to the room's next game are read from
-- those. origin says what started it: the lobby's Start, a rematch, the
-- host's Up next pick, a random match, or a solo game.
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'room', 'match')),
  room TEXT,
  category TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('easy', 'normal', 'hard')),
  origin TEXT NOT NULL CHECK (origin IN ('start', 'rematch', 'pick', 'match', 'solo')),
  players INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX games_time ON games (started_at);
CREATE INDEX games_room ON games (room, started_at);

-- An artist feed's track has no catalog row, so the title and artist the
-- round played are kept on the answer. Rows written before this migration
-- keep NULL.
ALTER TABLE round_outcomes ADD COLUMN game_id TEXT;
ALTER TABLE round_outcomes ADD COLUMN round INTEGER;
ALTER TABLE round_outcomes ADD COLUMN title TEXT;
ALTER TABLE round_outcomes ADD COLUMN artist TEXT;
CREATE INDEX round_outcomes_game ON round_outcomes (game_id);
