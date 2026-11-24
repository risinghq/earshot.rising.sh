import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { batchWrites, database, t } from "../../platform/db";
import type { Env } from "../../env";
import curatedList from "./curated.json";
import { deezerPlaylistTracks, deezerTrackYear, QuotaError } from "./sources";

// scripts/curate.ts writes this shape: a Deezer `id`, or an iTunes track with
// its unsigned `preview` URL and Apple Music `link`.
interface CuratedTrack {
  id?: number;
  itunesId?: number;
  preview?: string;
  link?: string;
  title: string;
  original?: string;
  artist: string;
  artistId: number | null;
  cover: string | null;
  year: number;
  work?: string;
  theme?: string;
}

const curated = curatedList as Record<string, Record<string, CuratedTrack[]>>;

export type CategorySource = typeof t.categorySources.$inferSelect;

const refreshIntervalSeconds = 86400;
const retryDelaySeconds = 3600;
const sourcesPerRun = 2;
// A curated source costs no request but writes a few hundred rows; the
// minutely cron refills the whole bundle within a few runs.
const curatedPerRun = 4;
// Deezer answers 50 requests per 5 seconds; a cron run stays under that and
// stops early on a quota body.
const yearsPerRun = 40;

interface SourceTrack {
  key: string;
  deezerId: number | null;
  title: string;
  original: string | null;
  work: string | null;
  theme: string | null;
  artist: string;
  artistId: number | null;
  cover: string | null;
  link: string | null;
  preview: string | null;
  year: number | null;
}

// A curated source's ref is `<category>/<decade>`, a key into the bundled
// list that scripts/curate.ts writes, with an optional third segment that
// keeps only tracks whose theme starts with it (`anime/1990/op`).
// A deploy applies migrations before the new code is live, so for a minute
// the old bundle can meet a source it has no list for. That is a failure to
// retry, not an empty source to keep for a day.
function curatedTracks(ref: string): SourceTrack[] {
  const [category, decade, theme] = ref.split("/");
  const list = curated[category]?.[decade];
  if (list === undefined) throw new Error(`no curated list for ${ref}`);
  return list
    .filter(
      (track) =>
        theme === undefined ||
        track.theme?.toLowerCase().startsWith(theme.toLowerCase()),
    )
    .map((track) => ({
      key: track.id === undefined ? `it:${track.itunesId}` : `dz:${track.id}`,
      deezerId: track.id ?? null,
      title: track.title,
      original: track.original ?? null,
      work: track.work ?? null,
      theme: track.theme ?? null,
      artist: track.artist,
      artistId: track.artistId,
      cover: track.cover,
      link: track.link ?? `https://www.deezer.com/track/${track.id}`,
      preview: track.preview ?? null,
      year: track.year,
    }));
}

async function playlistTracks(ref: string): Promise<SourceTrack[]> {
  return (await deezerPlaylistTracks(ref)).map((track) => ({
    key: `dz:${track.id}`,
    deezerId: track.id,
    title: track.title ?? "",
    original: null,
    work: null,
    theme: null,
    artist: track.artist?.name ?? "",
    artistId: track.artist?.id ?? null,
    cover: track.album?.cover_medium ?? null,
    link: track.link ?? null,
    preview: null,
    year: null,
  }));
}

function sourceTracks(source: CategorySource) {
  return source.kind === "curated"
    ? Promise.resolve(curatedTracks(source.ref))
    : playlistTracks(source.ref);
}

// A refetch rewrites the source's membership and the service fields of each
// track, but never touches the admin overrides or a ban. A curated year is
// the original release year and replaces a looked-up one; a playlist carries
// no year, so the stored one survives.
export async function refreshSource(
  env: Env,
  source: CategorySource,
  now: number,
) {
  const tracks = await sourceTracks(source);
  const db = database(env.DB);
  const ct = t.catalogTracks;
  await batchWrites(
    db,
    tracks.map((track) =>
      db
        .insert(ct)
        .values({
          trackKey: track.key,
          deezerId: track.deezerId,
          title: track.title,
          originalTitle: track.original,
          work: track.work,
          theme: track.theme,
          artist: track.artist,
          artistId: track.artistId,
          cover: track.cover,
          link: track.link,
          preview: track.preview,
          year: track.year,
          yearAt: track.year === null ? null : now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: ct.trackKey,
          set: {
            title: sql`excluded.title`,
            originalTitle: sql`excluded.original_title`,
            work: sql`excluded.work`,
            theme: sql`excluded.theme`,
            artist: sql`excluded.artist`,
            artistId: sql`excluded.artist_id`,
            cover: sql`excluded.cover`,
            link: sql`excluded.link`,
            preview: sql`excluded.preview`,
            year: sql`COALESCE(excluded.year, ${ct.year})`,
            yearAt: sql`COALESCE(excluded.year_at, ${ct.yearAt})`,
            updatedAt: sql`excluded.updated_at`,
          },
        }),
    ),
  );
  // One batch, so a reader never sees the source with half its members.
  await db.batch([
    db.delete(t.catalogMembers).where(eq(t.catalogMembers.sourceId, source.id)),
    ...tracks.map((track, position) =>
      db
        .insert(t.catalogMembers)
        .values({ sourceId: source.id, trackKey: track.key, position }),
    ),
    db
      .update(t.categorySources)
      .set({ refreshedAt: now, tracksCount: tracks.length })
      .where(eq(t.categorySources.id, source.id)),
  ]);
  await env.CACHE.delete(`play:cat:${source.category}`).catch(() => undefined);
  return tracks.length;
}

export async function refreshCategorySources(
  env: Env,
  category: string,
  now = Math.floor(Date.now() / 1000),
) {
  const cs = t.categorySources;
  const sources = await database(env.DB)
    .select()
    .from(cs)
    .where(eq(cs.category, category))
    .orderBy(cs.position, cs.id);
  for (const source of sources) await refreshSource(env, source, now);
  return sources.length;
}

function markRetry(env: Env, sourceId: number, retryAt: number) {
  return database(env.DB)
    .update(t.categorySources)
    .set({ refreshedAt: retryAt - refreshIntervalSeconds })
    .where(eq(t.categorySources.id, sourceId));
}

// The sources of one kind or the others whose day-old refill is due, oldest
// first.
function dueSources(env: Env, curated: boolean, cutoff: number, limit: number) {
  const cs = t.categorySources;
  return database(env.DB)
    .select()
    .from(cs)
    .where(
      and(
        curated ? eq(cs.kind, "curated") : ne(cs.kind, "curated"),
        or(isNull(cs.refreshedAt), lte(cs.refreshedAt, cutoff)),
      ),
    )
    .orderBy(asc(cs.refreshedAt))
    .limit(limit);
}

// Each cron run refreshes the sources due for a day-old refill and then
// spends the rest of its Deezer budget on missing release years. Curated
// sources have their own budget, since they cost no Deezer request.
export async function refreshCatalog(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  const cutoff = now - refreshIntervalSeconds;
  const [curatedDue, playlistsDue] = await database(env.DB).batch([
    dueSources(env, true, cutoff, curatedPerRun),
    dueSources(env, false, cutoff, sourcesPerRun),
  ]);
  for (const source of [...curatedDue, ...playlistsDue]) {
    try {
      await refreshSource(env, source, now);
    } catch (error) {
      if (error instanceof QuotaError) return;
      await markRetry(env, source.id, now + retryDelaySeconds);
    }
  }
  try {
    await fillMissingYears(env, yearsPerRun);
  } catch (error) {
    if (!(error instanceof QuotaError)) throw error;
  }
}

// A track whose lookup already ran has year_at set; a null release_date
// stays a null year without costing a request on every later run. Only a
// playlist track lacks a year, and playlists are Deezer's.
export async function fillMissingYears(env: Env, limit = yearsPerRun) {
  const db = database(env.DB);
  const ct = t.catalogTracks;
  const missing = await db
    .select({ trackKey: ct.trackKey, deezerId: ct.deezerId })
    .from(ct)
    .where(and(isNull(ct.year), isNull(ct.yearAt), isNotNull(ct.deezerId)))
    .limit(limit);
  const updated: string[] = [];
  try {
    for (const row of missing) {
      if (row.deezerId === null) continue;
      try {
        const year = await deezerTrackYear(row.deezerId);
        const wrote = await db
          .update(ct)
          .set({ year, yearAt: Math.floor(Date.now() / 1000) })
          .where(and(eq(ct.trackKey, row.trackKey), isNull(ct.year)));
        if ((wrote.meta.changes ?? 0) > 0) updated.push(row.trackKey);
      } catch (error) {
        if (error instanceof QuotaError) throw error;
        // A failed lookup stays unmarked and is retried on the next run.
      }
    }
  } finally {
    await dropTrackCaches(env, ...updated);
  }
  return missing.length;
}

// A catalog_tracks row is shared by every category whose sources list it,
// so a track-level change (ban, override, year) invalidates each cache.
export async function dropTrackCaches(env: Env, ...trackKeys: string[]) {
  if (trackKeys.length === 0) return;
  const rows = await database(env.DB)
    .selectDistinct({ category: t.categorySources.category })
    .from(t.catalogMembers)
    .innerJoin(
      t.categorySources,
      eq(t.categorySources.id, t.catalogMembers.sourceId),
    )
    .where(inArray(t.catalogMembers.trackKey, trackKeys));
  for (const row of rows)
    await env.CACHE.delete(`play:cat:${row.category}`).catch(() => undefined);
}
