-- Anime openings and Anime endings join the catalog. Each source reads the
-- shared anime list in src/play/catalog/curated.json and keeps the songs
-- whose theme starts with the ref's third segment.
INSERT INTO categories (slug, name, feed, ref, position) VALUES
  ('anime-openings', 'Anime openings', 'deezer_playlist', NULL, 52),
  ('anime-endings', 'Anime endings', 'deezer_playlist', NULL, 54);

INSERT INTO category_sources (category, kind, ref, title, decade, position)
VALUES
  ('anime-openings', 'curated', 'anime/1980/op', 'Curated 1980s', 1980, 0),
  ('anime-openings', 'curated', 'anime/1990/op', 'Curated 1990s', 1990, 1),
  ('anime-openings', 'curated', 'anime/2000/op', 'Curated 2000s', 2000, 2),
  ('anime-openings', 'curated', 'anime/2010/op', 'Curated 2010s', 2010, 3),
  ('anime-openings', 'curated', 'anime/2020/op', 'Curated 2020s', 2020, 4),
  ('anime-endings', 'curated', 'anime/1980/ed', 'Curated 1980s', 1980, 0),
  ('anime-endings', 'curated', 'anime/1990/ed', 'Curated 1990s', 1990, 1),
  ('anime-endings', 'curated', 'anime/2000/ed', 'Curated 2000s', 2000, 2),
  ('anime-endings', 'curated', 'anime/2010/ed', 'Curated 2010s', 2010, 3),
  ('anime-endings', 'curated', 'anime/2020/ed', 'Curated 2020s', 2020, 4);
