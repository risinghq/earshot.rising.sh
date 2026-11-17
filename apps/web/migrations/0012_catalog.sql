ALTER TABLE categories ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE TABLE category_sources (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL REFERENCES categories (slug) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deezer_playlist')),
  ref TEXT NOT NULL,
  title TEXT,
  tracks_count INTEGER,
  decade INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER,
  UNIQUE (category, kind, ref)
);

CREATE TABLE catalog_tracks (
  deezer_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artist_id INTEGER,
  cover TEXT,
  link TEXT,
  year INTEGER,
  year_at INTEGER,
  answer_title TEXT,
  answer_year INTEGER,
  banned_at INTEGER,
  ban_reason TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE catalog_members (
  source_id INTEGER NOT NULL REFERENCES category_sources (id) ON DELETE CASCADE,
  deezer_id INTEGER NOT NULL REFERENCES catalog_tracks (deezer_id),
  position INTEGER NOT NULL,
  PRIMARY KEY (source_id, deezer_id)
) WITHOUT ROWID;
CREATE INDEX catalog_members_track ON catalog_members (deezer_id);

CREATE TABLE round_outcomes (
  id INTEGER PRIMARY KEY,
  player_key TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  track_key TEXT NOT NULL,
  deezer_id INTEGER,
  category TEXT NOT NULL,
  era INTEGER,
  mode TEXT NOT NULL CHECK (mode IN ('choices', 'typed')),
  kind TEXT NOT NULL CHECK (kind IN ('solo', 'room', 'match')),
  correct INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  answered_at INTEGER NOT NULL
);
CREATE INDEX round_outcomes_player
  ON round_outcomes (player_key, category, era);
CREATE INDEX round_outcomes_track ON round_outcomes (track_key);
CREATE INDEX round_outcomes_user ON round_outcomes (user_id)
  WHERE user_id IS NOT NULL;

CREATE TABLE track_reports (
  id INTEGER PRIMARY KEY,
  track_key TEXT NOT NULL,
  deezer_id INTEGER,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  category TEXT,
  reason TEXT NOT NULL
    CHECK (reason IN ('wrong_song', 'bad_clip', 'wrong_title', 'other')),
  detail TEXT,
  player_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER,
  resolution TEXT
);
CREATE INDEX track_reports_open ON track_reports (created_at)
  WHERE resolved_at IS NULL;
CREATE INDEX track_reports_track ON track_reports (track_key)
  WHERE resolved_at IS NULL;

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY,
  github_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_actions_time ON admin_actions (created_at);

ALTER TABLE users ADD COLUMN admin_hidden INTEGER NOT NULL DEFAULT 0;

INSERT OR REPLACE INTO categories (slug, name, feed, ref, position) VALUES
  ('pop', 'Pop', 'deezer_playlist', NULL, 10),
  ('rock', 'Rock', 'deezer_playlist', NULL, 20),
  ('metal', 'Metal', 'deezer_playlist', NULL, 30),
  ('k-pop', 'K-pop', 'deezer_playlist', NULL, 40),
  ('anime', 'Anime', 'deezer_playlist', NULL, 50),
  ('rock-en-espanol', 'Rock en Español', 'deezer_playlist', NULL, 60),
  ('top-50-japan', 'Top 50 Japan', 'apple_chart', 'jp', 70),
  ('top-50-peru', 'Top 50 Peru', 'apple_chart', 'pe', 80),
  ('top-50-global', 'Top 50 Global', 'deezer_chart', '0', 90);
UPDATE categories SET position = 100 WHERE slug = 'mine';

INSERT INTO category_sources
  (category, kind, ref, title, decade, position) VALUES
  ('pop', 'deezer_playlist', '878989033', '90s Hits', 1990, 0),
  ('pop', 'deezer_playlist', '8326097522', '00s Pop', 2000, 1),
  ('rock', 'deezer_playlist', '8621268482', '80s Rock', 1980, 0),
  ('rock', 'deezer_playlist', '1728093421', '90s Rock', 1990, 1),
  ('metal', 'deezer_playlist', '1294679255', '80s Metal', 1980, 0),
  ('metal', 'deezer_playlist', '11879932521',
    'Heavy Metal Classics (Top 100)', NULL, 1),
  ('k-pop', 'deezer_playlist', '14464057043', '2000''s kpop', 2000, 0),
  ('k-pop', 'deezer_playlist', '15331991443', 'Kpop 2010s', 2010, 1),
  ('anime', 'deezer_playlist', '7270935024', 'Anime Songs 90s', 1990, 0),
  ('anime', 'deezer_playlist', '5206929684',
    'Anime Hits アニメ・ヒッツ', NULL, 1),
  ('rock-en-espanol', 'deezer_playlist', '905906815',
    'Rock en Español 80''s 90''s 2000''s', NULL, 0),
  ('rock-en-espanol', 'deezer_playlist', '1711617923',
    'Rock en español', NULL, 1);
