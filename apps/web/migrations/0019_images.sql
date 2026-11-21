-- Album cover of a track and picture of an artist, found on Deezer by name.
-- image_at is when the lookup ran: a row with image_at set and image NULL is a
-- miss, retried after a while (src/images.ts).
ALTER TABLE tracks ADD COLUMN image TEXT;
ALTER TABLE tracks ADD COLUMN image_at INTEGER;
ALTER TABLE artists ADD COLUMN image TEXT;
ALTER TABLE artists ADD COLUMN image_at INTEGER;
-- The cron reads a few rows a minute from each of these, so a lookup never
-- scans the whole table.
CREATE INDEX tracks_image_new ON tracks (id) WHERE image_at IS NULL;
CREATE INDEX tracks_image_miss ON tracks (image_at) WHERE image IS NULL;
CREATE INDEX artists_image_new ON artists (id) WHERE image_at IS NULL;
CREATE INDEX artists_image_miss ON artists (image_at) WHERE image IS NULL;
