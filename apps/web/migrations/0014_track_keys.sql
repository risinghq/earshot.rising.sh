-- A catalog track plays from Deezer or from a stored iTunes preview, so it is
-- keyed by track_key ('dz:<id>' or 'it:<id>'), the key round_outcomes and
-- track_reports already use. The copy keeps the admin overrides and bans.
CREATE TABLE catalog_tracks_next (
  track_key TEXT PRIMARY KEY,
  deezer_id INTEGER,
  title TEXT NOT NULL,
  original_title TEXT,
  artist TEXT NOT NULL,
  artist_id INTEGER,
  cover TEXT,
  link TEXT,
  preview TEXT,
  year INTEGER,
  year_at INTEGER,
  answer_title TEXT,
  answer_year INTEGER,
  banned_at INTEGER,
  ban_reason TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO catalog_tracks_next
  (track_key, deezer_id, title, artist, artist_id, cover, link, year, year_at,
   answer_title, answer_year, banned_at, ban_reason, updated_at)
SELECT 'dz:' || deezer_id, deezer_id, title, artist, artist_id, cover, link,
  year, year_at, answer_title, answer_year, banned_at, ban_reason, updated_at
FROM catalog_tracks;

CREATE TABLE catalog_members_next (
  source_id INTEGER NOT NULL REFERENCES category_sources (id) ON DELETE CASCADE,
  track_key TEXT NOT NULL REFERENCES catalog_tracks_next (track_key),
  position INTEGER NOT NULL,
  PRIMARY KEY (source_id, track_key)
) WITHOUT ROWID;

INSERT INTO catalog_members_next (source_id, track_key, position)
SELECT source_id, 'dz:' || deezer_id, position FROM catalog_members;

DROP TABLE catalog_members;
DROP TABLE catalog_tracks;
ALTER TABLE catalog_tracks_next RENAME TO catalog_tracks;
ALTER TABLE catalog_members_next RENAME TO catalog_members;
CREATE INDEX catalog_members_track ON catalog_members (track_key);

ALTER TABLE round_outcomes DROP COLUMN deezer_id;
ALTER TABLE track_reports DROP COLUMN deezer_id;

-- The curated bundle now carries iTunes tracks and romanized titles.
UPDATE category_sources SET refreshed_at = NULL WHERE kind = 'curated';
