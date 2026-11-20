-- Three genres join the catalog, and the existing ones gain a decade at
-- either end. Each source reads its list from src/play/curated.json.
INSERT INTO categories (slug, name, feed, ref, position) VALUES
  ('hip-hop', 'Hip-hop', 'deezer_playlist', NULL, 62),
  ('latin', 'Latin', 'deezer_playlist', NULL, 64),
  ('j-pop', 'J-pop', 'deezer_playlist', NULL, 66);

INSERT INTO category_sources (category, kind, ref, title, decade, position)
VALUES
  ('pop', 'curated', 'pop/1960', 'Curated 1960s', 1960, -1),
  ('rock', 'curated', 'rock/1960', 'Curated 1960s', 1960, -1),
  ('rock', 'curated', 'rock/2010', 'Curated 2010s', 2010, 4),
  ('metal', 'curated', 'metal/1970', 'Curated 1970s', 1970, -1),
  ('metal', 'curated', 'metal/2020', 'Curated 2020s', 2020, 4),
  ('k-pop', 'curated', 'k-pop/1990', 'Curated 1990s', 1990, -1),
  ('anime', 'curated', 'anime/1980', 'Curated 1980s', 1980, -1),
  ('rock-en-espanol', 'curated', 'rock-en-espanol/2010', 'Curated 2010s',
    2010, 3),
  ('hip-hop', 'curated', 'hip-hop/1990', 'Curated 1990s', 1990, 0),
  ('hip-hop', 'curated', 'hip-hop/2000', 'Curated 2000s', 2000, 1),
  ('hip-hop', 'curated', 'hip-hop/2010', 'Curated 2010s', 2010, 2),
  ('hip-hop', 'curated', 'hip-hop/2020', 'Curated 2020s', 2020, 3),
  ('latin', 'curated', 'latin/1990', 'Curated 1990s', 1990, 0),
  ('latin', 'curated', 'latin/2000', 'Curated 2000s', 2000, 1),
  ('latin', 'curated', 'latin/2010', 'Curated 2010s', 2010, 2),
  ('latin', 'curated', 'latin/2020', 'Curated 2020s', 2020, 3),
  ('j-pop', 'curated', 'j-pop/1990', 'Curated 1990s', 1990, 0),
  ('j-pop', 'curated', 'j-pop/2000', 'Curated 2000s', 2000, 1),
  ('j-pop', 'curated', 'j-pop/2010', 'Curated 2010s', 2010, 2),
  ('j-pop', 'curated', 'j-pop/2020', 'Curated 2020s', 2020, 3);
