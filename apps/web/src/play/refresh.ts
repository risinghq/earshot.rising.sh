import type { Env } from "../types";
import { deezerPlaylistTracks, deezerTrackYear, QuotaError } from "./sources";

export interface CategorySource {
  id: number;
  category: string;
  kind: string;
  ref: string;
  title: string | null;
  tracks_count: number | null;
  decade: number | null;
  position: number;
  refreshed_at: number | null;
}

const refreshIntervalSeconds = 86400;
const retryDelaySeconds = 3600;
const sourcesPerRun = 2;
// Deezer answers 50 requests per 5 seconds; a cron run stays under that and
// stops early on a quota body.
const yearsPerRun = 40;

// A refetch rewrites the source's membership and the service fields of each
// track, but never touches year, the admin overrides or a ban: those survive.
export async function refreshSource(
  env: Env,
  source: CategorySource,
  now: number,
) {
  const tracks = await deezerPlaylistTracks(source.ref);
  const statements: D1PreparedStatement[] = tracks.map((track) =>
    env.DB.prepare(
      `INSERT INTO catalog_tracks
         (deezer_id, title, artist, artist_id, cover, link, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (deezer_id) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         artist_id = excluded.artist_id,
         cover = excluded.cover,
         link = excluded.link,
         updated_at = excluded.updated_at`,
    ).bind(
      track.id,
      track.title ?? "",
      track.artist?.name ?? "",
      track.artist?.id ?? null,
      track.album?.cover_medium ?? null,
      track.link ?? null,
      now,
    ),
  );
  for (let index = 0; index < statements.length; index += 100)
    await env.DB.batch(statements.slice(index, index + 100));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM catalog_members WHERE source_id = ?1").bind(
      source.id,
    ),
    ...tracks.map((track, position) =>
      env.DB.prepare(
        `INSERT INTO catalog_members (source_id, deezer_id, position)
         VALUES (?1, ?2, ?3)`,
      ).bind(source.id, track.id, position),
    ),
    env.DB.prepare(
      "UPDATE category_sources SET refreshed_at = ?1, tracks_count = ?2 WHERE id = ?3",
    ).bind(now, tracks.length, source.id),
  ]);
  await env.CACHE?.delete(`play:cat:${source.category}`).catch(() => undefined);
  return tracks.length;
}

export async function refreshCategorySources(
  env: Env,
  category: string,
  now = Math.floor(Date.now() / 1000),
) {
  const sources = await env.DB.prepare(
    "SELECT * FROM category_sources WHERE category = ?1 ORDER BY position, id",
  )
    .bind(category)
    .all<CategorySource>();
  for (const source of sources.results) await refreshSource(env, source, now);
  return sources.results.length;
}

async function markRetry(db: D1Database, sourceId: number, retryAt: number) {
  await db
    .prepare("UPDATE category_sources SET refreshed_at = ?1 WHERE id = ?2")
    .bind(retryAt - refreshIntervalSeconds, sourceId)
    .run();
}

// Each cron run refreshes the sources due for a day-old refill and then
// spends the rest of its Deezer budget on missing release years.
export async function refreshCatalog(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  const due = await env.DB.prepare(
    `SELECT * FROM category_sources
     WHERE refreshed_at IS NULL OR refreshed_at <= ?1
     ORDER BY refreshed_at LIMIT ?2`,
  )
    .bind(now - refreshIntervalSeconds, sourcesPerRun)
    .all<CategorySource>();
  for (const source of due.results) {
    try {
      await refreshSource(env, source, now);
    } catch (error) {
      if (error instanceof QuotaError) return;
      await markRetry(env.DB, source.id, now + retryDelaySeconds);
    }
  }
  try {
    await fillMissingYears(env, yearsPerRun);
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
  }
}

// A track whose lookup already ran has year_at set; a null release_date
// stays a null year without costing a request on every later run.
export async function fillMissingYears(env: Env, limit = yearsPerRun) {
  const missing = await env.DB.prepare(
    `SELECT deezer_id FROM catalog_tracks
     WHERE year IS NULL AND year_at IS NULL LIMIT ?1`,
  )
    .bind(limit)
    .all<{ deezer_id: number }>();
  const updated: number[] = [];
  try {
    for (const row of missing.results) {
      try {
        const year = await deezerTrackYear(row.deezer_id);
        const wrote = await env.DB.prepare(
          `UPDATE catalog_tracks SET year = ?1, year_at = ?2
           WHERE deezer_id = ?3 AND year IS NULL`,
        )
          .bind(year, Math.floor(Date.now() / 1000), row.deezer_id)
          .run();
        if ((wrote.meta.changes ?? 0) > 0) updated.push(row.deezer_id);
      } catch (error) {
        if (error instanceof QuotaError) throw error;
        // A failed lookup stays unmarked and is retried on the next run.
      }
    }
  } finally {
    if (updated.length > 0) {
      const rows = await env.DB.prepare(
        `SELECT DISTINCT cs.category FROM catalog_members cm
         JOIN category_sources cs ON cs.id = cm.source_id
         WHERE cm.deezer_id IN (${updated.map(() => "?").join(",")})`,
      )
        .bind(...updated)
        .all<{ category: string }>();
      for (const row of rows.results)
        await env.CACHE?.delete(`play:cat:${row.category}`).catch(
          () => undefined,
        );
    }
  }
  return missing.results.length;
}

// A catalog_tracks row is shared by every category whose sources list it,
// so a track-level change (ban, override, year) invalidates each cache.
export async function dropTrackCaches(env: Env, deezerId: number) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT cs.category FROM catalog_members cm
     JOIN category_sources cs ON cs.id = cm.source_id
     WHERE cm.deezer_id = ?1`,
  )
    .bind(deezerId)
    .all<{ category: string }>();
  for (const row of rows.results)
    await env.CACHE?.delete(`play:cat:${row.category}`).catch(() => undefined);
}
