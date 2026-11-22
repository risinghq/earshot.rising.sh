-- K-pop's eras are generations, not decades: each curated source holds the
-- acts of one generation, keyed by its first year (src/play/eras.ts). The
-- cron fills the new sources from src/play/curated.json.
DELETE FROM catalog_members
WHERE source_id IN (
  SELECT id FROM category_sources WHERE category = 'k-pop' AND kind = 'curated'
);
DELETE FROM category_sources WHERE category = 'k-pop' AND kind = 'curated';

INSERT INTO category_sources (category, kind, ref, title, decade, position)
VALUES
  ('k-pop', 'curated', 'k-pop/1996', 'Curated 1st gen', 1996, 0),
  ('k-pop', 'curated', 'k-pop/2004', 'Curated 2nd gen', 2004, 1),
  ('k-pop', 'curated', 'k-pop/2012', 'Curated 3rd gen', 2012, 2),
  ('k-pop', 'curated', 'k-pop/2018', 'Curated 4th gen', 2018, 3),
  ('k-pop', 'curated', 'k-pop/2023', 'Curated 5th gen', 2023, 4);
