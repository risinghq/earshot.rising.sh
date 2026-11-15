CREATE TABLE game_results (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  finished_at INTEGER NOT NULL,
  category TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'room', 'match')),
  score INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  players INTEGER NOT NULL
);
CREATE INDEX game_results_user ON game_results (user_id, finished_at);
CREATE INDEX game_results_time ON game_results (finished_at);
