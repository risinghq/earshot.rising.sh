-- Six genres join the catalog. Each source reads its list from
-- src/play/curated.json.
INSERT INTO categories (slug, name, feed, ref, position) VALUES
  ('reggaeton', 'Reggaeton', 'deezer_playlist', NULL, 68),
  ('salsa-cumbia', 'Salsa & Cumbia', 'deezer_playlist', NULL, 70),
  ('country', 'Country', 'deezer_playlist', NULL, 72),
  ('r-and-b', 'R&B', 'deezer_playlist', NULL, 74),
  ('edm', 'EDM', 'deezer_playlist', NULL, 76),
  ('soundtracks', 'Soundtracks', 'deezer_playlist', NULL, 78);

INSERT INTO category_sources (category, kind, ref, title, decade, position)
VALUES
  ('reggaeton', 'curated', 'reggaeton/2000', 'Curated 2000s', 2000, 0),
  ('reggaeton', 'curated', 'reggaeton/2010', 'Curated 2010s', 2010, 1),
  ('reggaeton', 'curated', 'reggaeton/2020', 'Curated 2020s', 2020, 2),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/1970', 'Curated 1970s', 1970, 0),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/1980', 'Curated 1980s', 1980, 1),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/1990', 'Curated 1990s', 1990, 2),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/2000', 'Curated 2000s', 2000, 3),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/2010', 'Curated 2010s', 2010, 4),
  ('salsa-cumbia', 'curated', 'salsa-cumbia/2020', 'Curated 2020s', 2020, 5),
  ('country', 'curated', 'country/1970', 'Curated 1970s', 1970, 0),
  ('country', 'curated', 'country/1980', 'Curated 1980s', 1980, 1),
  ('country', 'curated', 'country/1990', 'Curated 1990s', 1990, 2),
  ('country', 'curated', 'country/2000', 'Curated 2000s', 2000, 3),
  ('country', 'curated', 'country/2010', 'Curated 2010s', 2010, 4),
  ('country', 'curated', 'country/2020', 'Curated 2020s', 2020, 5),
  ('r-and-b', 'curated', 'r-and-b/1970', 'Curated 1970s', 1970, 0),
  ('r-and-b', 'curated', 'r-and-b/1980', 'Curated 1980s', 1980, 1),
  ('r-and-b', 'curated', 'r-and-b/1990', 'Curated 1990s', 1990, 2),
  ('r-and-b', 'curated', 'r-and-b/2000', 'Curated 2000s', 2000, 3),
  ('r-and-b', 'curated', 'r-and-b/2010', 'Curated 2010s', 2010, 4),
  ('r-and-b', 'curated', 'r-and-b/2020', 'Curated 2020s', 2020, 5),
  ('edm', 'curated', 'edm/1990', 'Curated 1990s', 1990, 0),
  ('edm', 'curated', 'edm/2000', 'Curated 2000s', 2000, 1),
  ('edm', 'curated', 'edm/2010', 'Curated 2010s', 2010, 2),
  ('edm', 'curated', 'edm/2020', 'Curated 2020s', 2020, 3),
  ('soundtracks', 'curated', 'soundtracks/1970', 'Curated 1970s', 1970, 0),
  ('soundtracks', 'curated', 'soundtracks/1980', 'Curated 1980s', 1980, 1),
  ('soundtracks', 'curated', 'soundtracks/1990', 'Curated 1990s', 1990, 2),
  ('soundtracks', 'curated', 'soundtracks/2000', 'Curated 2000s', 2000, 3),
  ('soundtracks', 'curated', 'soundtracks/2010', 'Curated 2010s', 2010, 4),
  ('soundtracks', 'curated', 'soundtracks/2020', 'Curated 2020s', 2020, 5);
