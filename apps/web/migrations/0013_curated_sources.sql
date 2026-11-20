-- A curated source reads the list bundled in src/play/curated.json, so the
-- kind check is rebuilt to admit it. Dropping the old table cascades away
-- every membership; the surviving playlists are marked due to refill them.
CREATE TABLE category_sources_next (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL REFERENCES categories (slug) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deezer_playlist', 'curated')),
  ref TEXT NOT NULL,
  title TEXT,
  tracks_count INTEGER,
  decade INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  refreshed_at INTEGER,
  UNIQUE (category, kind, ref)
);

-- The playlists 0012 seeded are replaced by the curated lists.
INSERT INTO category_sources_next
  (id, category, kind, ref, title, tracks_count, decade, position)
SELECT id, category, kind, ref, title, tracks_count, decade, position + 100
FROM category_sources
WHERE NOT (category, ref) IN (VALUES
  ('pop', '878989033'), ('pop', '8326097522'),
  ('rock', '8621268482'), ('rock', '1728093421'),
  ('metal', '1294679255'), ('metal', '11879932521'),
  ('k-pop', '14464057043'), ('k-pop', '15331991443'),
  ('anime', '7270935024'), ('anime', '5206929684'),
  ('rock-en-espanol', '905906815'), ('rock-en-espanol', '1711617923'));

DROP TABLE category_sources;
ALTER TABLE category_sources_next RENAME TO category_sources;

INSERT INTO category_sources (category, kind, ref, title, decade, position)
VALUES
  ('pop', 'curated', 'pop/1970', 'Curated 1970s', 1970, 0),
  ('pop', 'curated', 'pop/1980', 'Curated 1980s', 1980, 1),
  ('pop', 'curated', 'pop/1990', 'Curated 1990s', 1990, 2),
  ('pop', 'curated', 'pop/2000', 'Curated 2000s', 2000, 3),
  ('pop', 'curated', 'pop/2010', 'Curated 2010s', 2010, 4),
  ('pop', 'curated', 'pop/2020', 'Curated 2020s', 2020, 5),
  ('rock', 'curated', 'rock/1970', 'Curated 1970s', 1970, 0),
  ('rock', 'curated', 'rock/1980', 'Curated 1980s', 1980, 1),
  ('rock', 'curated', 'rock/1990', 'Curated 1990s', 1990, 2),
  ('rock', 'curated', 'rock/2000', 'Curated 2000s', 2000, 3),
  ('metal', 'curated', 'metal/1980', 'Curated 1980s', 1980, 0),
  ('metal', 'curated', 'metal/1990', 'Curated 1990s', 1990, 1),
  ('metal', 'curated', 'metal/2000', 'Curated 2000s', 2000, 2),
  ('metal', 'curated', 'metal/2010', 'Curated 2010s', 2010, 3),
  ('k-pop', 'curated', 'k-pop/2000', 'Curated 2000s', 2000, 0),
  ('k-pop', 'curated', 'k-pop/2010', 'Curated 2010s', 2010, 1),
  ('k-pop', 'curated', 'k-pop/2020', 'Curated 2020s', 2020, 2),
  ('anime', 'curated', 'anime/1990', 'Curated 1990s', 1990, 0),
  ('anime', 'curated', 'anime/2000', 'Curated 2000s', 2000, 1),
  ('anime', 'curated', 'anime/2010', 'Curated 2010s', 2010, 2),
  ('anime', 'curated', 'anime/2020', 'Curated 2020s', 2020, 3),
  ('rock-en-espanol', 'curated', 'rock-en-espanol/1980', 'Curated 1980s',
    1980, 0),
  ('rock-en-espanol', 'curated', 'rock-en-espanol/1990', 'Curated 1990s',
    1990, 1),
  ('rock-en-espanol', 'curated', 'rock-en-espanol/2000', 'Curated 2000s',
    2000, 2);
