-- The two answer modes became three difficulties: four choices are now
-- Normal (titles only) and typed answers are Hard. Easy adds the artists.
CREATE TABLE round_outcomes_next (
  id INTEGER PRIMARY KEY,
  player_key TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  track_key TEXT NOT NULL,
  category TEXT NOT NULL,
  era INTEGER,
  mode TEXT NOT NULL CHECK (mode IN ('easy', 'normal', 'hard')),
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'room', 'match')),
  correct INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  answered_at INTEGER NOT NULL
);

INSERT INTO round_outcomes_next
  (id, player_key, user_id, track_key, category, era, mode, kind, correct,
   elapsed_ms, answered_at)
SELECT id, player_key, user_id, track_key, category, era,
  CASE mode WHEN 'typed' THEN 'hard' ELSE 'normal' END,
  kind, correct, elapsed_ms, answered_at
FROM round_outcomes;

DROP TABLE round_outcomes;
ALTER TABLE round_outcomes_next RENAME TO round_outcomes;

CREATE INDEX round_outcomes_player
  ON round_outcomes (player_key, category, era);
CREATE INDEX round_outcomes_track ON round_outcomes (track_key);
CREATE INDEX round_outcomes_user ON round_outcomes (user_id)
  WHERE user_id IS NOT NULL;
