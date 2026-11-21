import {
  deezerArtistPicture,
  deezerTrackCover,
  QuotaError,
} from "./play/sources";
import type { Env } from "./types";

// Each cron tick looks up this many tracks and this many artists. Twelve
// Deezer requests a minute stay far under its 50 per 5 seconds, and leave the
// tick's subrequest budget to the source pulls.
export const imagesPerTick = 6;

// A miss is looked up again after this long, since Deezer's catalogue grows.
export const missRetrySeconds = 30 * 86400;

type Kind = "tracks" | "artists";

interface Due {
  id: number;
  name: string;
  artist: string | null;
}

const dueSql: Record<Kind, { fresh: string; miss: string }> = {
  tracks: {
    fresh: `SELECT tracks.id, tracks.title AS name, artists.name AS artist
            FROM tracks JOIN artists ON artists.id = tracks.artist_id
            WHERE tracks.image_at IS NULL ORDER BY tracks.id DESC LIMIT ?1`,
    miss: `SELECT tracks.id, tracks.title AS name, artists.name AS artist
           FROM tracks JOIN artists ON artists.id = tracks.artist_id
           WHERE tracks.image IS NULL AND tracks.image_at < ?2
           ORDER BY tracks.image_at LIMIT ?1`,
  },
  artists: {
    fresh: `SELECT id, name, NULL AS artist FROM artists
            WHERE image_at IS NULL ORDER BY id DESC LIMIT ?1`,
    miss: `SELECT id, name, NULL AS artist FROM artists
           WHERE image IS NULL AND image_at < ?2 ORDER BY image_at LIMIT ?1`,
  },
};

async function dueRows(db: D1Database, kind: Kind, now: number) {
  const fresh = await db
    .prepare(dueSql[kind].fresh)
    .bind(imagesPerTick)
    .all<Due>();
  const left = imagesPerTick - fresh.results.length;
  if (left === 0) return fresh.results;
  const miss = await db
    .prepare(dueSql[kind].miss)
    .bind(left, now - missRetrySeconds)
    .all<Due>();
  return [...fresh.results, ...miss.results];
}

function lookUp(kind: Kind, row: Due) {
  return kind === "tracks"
    ? deezerTrackCover(row.artist ?? "", row.name)
    : deezerArtistPicture(row.name);
}

// Fills the album covers and artist pictures the profile shows. A failed
// fetch leaves the row due for the next tick; a Deezer quota error ends the
// tick.
export async function fillImages(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  for (const kind of ["tracks", "artists"] as const) {
    const updates: D1PreparedStatement[] = [];
    for (const row of await dueRows(env.DB, kind, now)) {
      let image: string | null;
      try {
        image = await lookUp(kind, row);
      } catch (error) {
        if (error instanceof QuotaError) break;
        continue;
      }
      updates.push(
        env.DB.prepare(
          `UPDATE ${kind} SET image = ?1, image_at = ?2 WHERE id = ?3`,
        ).bind(image, now, row.id),
      );
    }
    if (updates.length > 0) await env.DB.batch(updates);
  }
}
