import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { union } from "drizzle-orm/sqlite-core";
import { batchOf, jsonField, jsonRows, t, type Db } from "./db";
import { normalizeText } from "./normalize";
import type { TrackInput } from "./types";

interface BulkListen extends TrackInput {
  listenedAt: number;
  userId: number;
  sourceId: number;
  ref?: string;
}

interface PreparedFields {
  artistKey: string;
  titleKey: string;
  normalizedKey: string;
}

export interface ExistingTrack {
  id: number;
  key: string;
  mbid: string | null;
  isrc: string | null;
  artistKey: string;
  titleKey: string;
}

interface WalkTrack extends Omit<ExistingTrack, "id"> {
  id: number | null;
  artist: string;
  title: string;
}

export interface ResolvedListen {
  sourceKey: string;
  trackKey: string;
  listenedAt: number;
  userId: number;
  sourceId: number;
  ref: string;
}

export interface NewTrack {
  key: string;
  artistKey: string;
  artist: string;
  title: string;
  mbid: string | null;
  isrc: string | null;
}

export interface PageResolution {
  listens: ResolvedListen[];
  newTracks: NewTrack[];
}

// A track key is the artist key and the title key joined by U+001F.
const titleKey =
  sql<string>`substr(${t.tracks.key}, instr(${t.tracks.key}, char(31)) + 1)`.as(
    "titleKey",
  );

const trackFields = {
  id: t.tracks.id,
  key: t.tracks.key,
  mbid: t.tracks.mbid,
  isrc: t.tracks.isrc,
  artistKey: t.artists.key,
  titleKey,
};

type Candidate = {
  normalizedKey: string;
  mbid: string | null;
  isrc: string | null;
};

// The stored tracks a page could match by key, MBID or ISRC. Each branch
// reads one indexed column, so none scans the tracks table.
export function trackCandidates(db: Db, candidates: Candidate[]) {
  const branch = (column: AnyColumn, name: keyof Candidate) =>
    db
      .select(trackFields)
      .from(t.tracks)
      .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
      .where(
        inArray(
          column,
          db
            .select({ value: jsonField<string>(name) })
            .from(jsonRows(candidates)),
        ),
      );
  return union(
    branch(t.tracks.key, "normalizedKey"),
    branch(t.tracks.mbid, "mbid"),
    branch(t.tracks.isrc, "isrc"),
    // A compound select orders by output position or alias; column 1 is id.
  ).orderBy(sql`1`);
}

function artistInsert(db: Db, newTracks: NewTrack[]) {
  const artists = new Map<string, string>();
  for (const track of newTracks)
    if (!artists.has(track.artistKey))
      artists.set(track.artistKey, track.artist);
  return db
    .insert(t.artists)
    .select(
      db
        .select({
          key: jsonField<string>("k").as("key"),
          name: jsonField<string>("a").as("name"),
        })
        .from(jsonRows([...artists].map(([k, a]) => ({ k, a }))))
        .where(sql`true`),
    )
    .onConflictDoNothing();
}

function trackInsert(db: Db, newTracks: NewTrack[]) {
  const artistId = db
    .select({ id: t.artists.id })
    .from(t.artists)
    .where(eq(t.artists.key, jsonField<string>("artistKey")));
  return db
    .insert(t.tracks)
    .select(
      db
        .select({
          key: jsonField<string>("key").as("key"),
          artistId: sql<number>`(${artistId})`.as("artist_id"),
          title: jsonField<string>("title").as("title"),
          mbid: jsonField<string | null>("mbid").as("mbid"),
          isrc: jsonField<string | null>("isrc").as("isrc"),
        })
        .from(jsonRows(newTracks))
        .where(sql`true`),
    )
    .onConflictDoNothing();
}

function aliasInsert(db: Db, listens: ResolvedListen[], kind: string) {
  const rows = new Map<string, string>();
  for (const listen of listens)
    if (!rows.has(listen.sourceKey))
      rows.set(listen.sourceKey, listen.trackKey);
  return db
    .insert(t.trackAliases)
    .select(
      db
        .select({
          kind: sql<string>`${kind}`.as("kind"),
          sourceKey: jsonField<string>("s").as("source_key"),
          trackId: t.tracks.id,
        })
        .from(jsonRows([...rows].map(([s, k]) => ({ s, k }))))
        .innerJoin(t.tracks, eq(t.tracks.key, jsonField<string>("k")))
        .where(sql`true`),
    )
    .onConflictDoNothing();
}

// The artist, track and alias rows a resolved page adds, in the order the
// plays need them. One batch runs them as one transaction.
export function pageWrites(
  db: Db,
  { listens, newTracks }: PageResolution,
  kind: string,
): BatchItem<"sqlite">[] {
  const writes: BatchItem<"sqlite">[] = [];
  if (newTracks.length > 0)
    writes.push(artistInsert(db, newTracks), trackInsert(db, newTracks));
  if (listens.length > 0) writes.push(aliasInsert(db, listens, kind));
  return writes;
}

// Returns one row per play it inserted; a play already stored is skipped.
// `guard` gates the whole page on a condition read in the same statement.
export function playInsert(
  db: Db,
  listens: ResolvedListen[],
  guard: SQL = sql`true`,
) {
  return db
    .insert(t.plays)
    .select(
      db
        .select({
          userId: jsonField<number>("u").as("user_id"),
          playedAt: jsonField<number>("at").as("played_at"),
          sourceId: jsonField<number>("s").as("source_id"),
          ref: jsonField<string>("r").as("ref"),
          trackId: t.tracks.id,
        })
        .from(
          jsonRows(
            listens.map((listen) => ({
              u: listen.userId,
              at: listen.listenedAt,
              s: listen.sourceId,
              r: listen.ref,
              k: listen.trackKey,
            })),
          ),
        )
        .innerJoin(t.tracks, eq(t.tracks.key, jsonField<string>("k")))
        .where(guard),
    )
    .onConflictDoNothing()
    .returning({ trackId: t.plays.trackId });
}

interface NormalizeCache {
  artists: Map<string, string>;
  titles: Map<string, string>;
}

const newCache = (): NormalizeCache => ({
  artists: new Map(),
  titles: new Map(),
});

function normalizeCached(
  cache: Map<string, string>,
  raw: string,
  removeTopic: boolean,
) {
  let key = cache.get(raw);
  if (key === undefined) {
    key = normalizeText(raw, removeTopic);
    cache.set(raw, key);
  }
  return key;
}

function prepareFields(
  input: BulkListen,
  cache: NormalizeCache,
): PreparedFields {
  const artistKey = normalizeCached(
    cache.artists,
    input.artist,
    input.kind === "ytmusic",
  );
  const titleKey = normalizeCached(cache.titles, input.title, false);
  return {
    artistKey,
    titleKey,
    normalizedKey: artistKey + "\u001f" + titleKey,
  };
}

function sameIdentifier(
  fields: PreparedFields,
  track: Pick<WalkTrack, "artistKey" | "titleKey">,
) {
  return (
    fields.artistKey === track.artistKey || fields.titleKey === track.titleKey
  );
}

function asWalkTrack(track: ExistingTrack): WalkTrack {
  return { ...track, artist: "", title: "" };
}

function resolvePage(
  inputs: readonly BulkListen[],
  prepared: ReadonlyMap<string, PreparedFields>,
  aliases: ReadonlyMap<string, ExistingTrack>,
  existingTracks: readonly ExistingTrack[],
): PageResolution {
  const byKey = new Map<string, WalkTrack>();
  const byMbid = new Map<string, WalkTrack[]>();
  const byIsrc = new Map<string, WalkTrack[]>();
  const loadedTracks = new Map<number, WalkTrack>();

  const addIdentifier = (
    index: Map<string, WalkTrack[]>,
    value: string | null,
    track: WalkTrack,
  ) => {
    if (!value) return;
    const candidates = index.get(value);
    if (candidates) candidates.push(track);
    else index.set(value, [track]);
  };

  const addTrack = (track: WalkTrack) => {
    byKey.set(track.key, track);
    addIdentifier(byMbid, track.mbid, track);
    addIdentifier(byIsrc, track.isrc, track);
  };

  for (const track of existingTracks) {
    loadedTracks.set(track.id, asWalkTrack(track));
  }
  for (const track of aliases.values()) {
    loadedTracks.set(track.id, asWalkTrack(track));
  }
  for (const track of loadedTracks.values()) addTrack(track);

  const newTracks = new Map<string, NewTrack>();
  const pageAliases = new Map<string, WalkTrack>();
  const resolved: ResolvedListen[] = [];

  for (const input of inputs) {
    let track: WalkTrack | undefined;
    const aliasedTrack = aliases.get(input.sourceKey);
    if (aliasedTrack) track = asWalkTrack(aliasedTrack);
    if (!track) track = pageAliases.get(input.sourceKey);
    if (!track) {
      const fields = prepared.get(input.sourceKey)!;
      const mbidCandidates = input.mbid ? byMbid.get(input.mbid) : undefined;
      track = mbidCandidates?.find((candidate) =>
        sameIdentifier(fields, candidate),
      );
      if (!track) {
        const isrcCandidates = input.isrc ? byIsrc.get(input.isrc) : undefined;
        track = isrcCandidates?.find((candidate) =>
          sameIdentifier(fields, candidate),
        );
      }
      if (!track) track = byKey.get(fields.normalizedKey);
      if (!track) {
        const newTrack: WalkTrack = {
          id: null,
          key: fields.normalizedKey,
          mbid: input.mbid ?? null,
          isrc: input.isrc ?? null,
          artistKey: fields.artistKey,
          titleKey: fields.titleKey,
          artist: input.artist,
          title: input.title,
        };
        track = newTrack;
        addTrack(track);
        newTracks.set(track.key, {
          key: track.key,
          artistKey: track.artistKey,
          artist: track.artist,
          title: track.title,
          mbid: track.mbid,
          isrc: track.isrc,
        });
      }
    }

    addIdentifier(byMbid, input.mbid ?? null, track);
    addIdentifier(byIsrc, input.isrc ?? null, track);
    pageAliases.set(input.sourceKey, track);
    resolved.push({
      sourceKey: input.sourceKey,
      trackKey: track.key,
      listenedAt: input.listenedAt,
      userId: input.userId,
      sourceId: input.sourceId,
      ref: input.ref ?? "",
    });
  }

  return { listens: resolved, newTracks: [...newTracks.values()] };
}

function preparePage(
  inputs: readonly BulkListen[],
  skip: ReadonlySet<string>,
  cache: NormalizeCache,
) {
  const prepared = new Map<string, PreparedFields>();
  for (const input of inputs) {
    if (skip.has(input.sourceKey) || prepared.has(input.sourceKey)) continue;
    prepared.set(input.sourceKey, prepareFields(input, cache));
  }
  return prepared;
}

export function resolvePageTracks(
  inputs: BulkListen[],
  aliases: ReadonlyMap<string, ExistingTrack>,
  existingTracks: readonly ExistingTrack[],
) {
  const prepared = preparePage(inputs, new Set(), newCache());
  return resolvePage(inputs, prepared, aliases, existingTracks);
}

async function readAliases(db: Db, inputs: BulkListen[], kind: string) {
  const rows = await db
    .select({ sourceKey: t.trackAliases.sourceKey, ...trackFields })
    .from(t.trackAliases)
    .innerJoin(t.tracks, eq(t.tracks.id, t.trackAliases.trackId))
    .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
    .where(
      and(
        eq(t.trackAliases.kind, kind),
        inArray(
          t.trackAliases.sourceKey,
          db
            .select({ value: sql<string>`value` })
            .from(jsonRows(inputs.map((input) => input.sourceKey))),
        ),
      ),
    )
    .orderBy(t.tracks.id);
  const aliases = new Map<string, ExistingTrack>();
  const tracks = new Map<number, ExistingTrack>();
  for (const { sourceKey, ...track } of rows) {
    aliases.set(sourceKey, track);
    tracks.set(track.id, track);
  }
  return { aliases, tracks };
}

export async function resolveStoredPage(
  db: Db,
  inputs: BulkListen[],
  kind: string,
): Promise<PageResolution> {
  const existing = await readAliases(db, inputs, kind);
  const prepared = preparePage(
    inputs,
    new Set(existing.aliases.keys()),
    newCache(),
  );
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const fields = prepared.get(input.sourceKey);
    if (!fields || seen.has(input.sourceKey)) continue;
    seen.add(input.sourceKey);
    candidates.push({
      normalizedKey: fields.normalizedKey,
      mbid: input.mbid ?? null,
      isrc: input.isrc ?? null,
    });
  }
  if (candidates.length > 0)
    for (const row of await trackCandidates(db, candidates))
      existing.tracks.set(row.id, row);
  return resolvePage(inputs, prepared, existing.aliases, [
    ...existing.tracks.values(),
  ]);
}

// Stores a page of listens and returns how many plays were new.
export async function storeListens(
  db: Db,
  inputs: BulkListen[],
  kind: string,
): Promise<number> {
  if (inputs.length === 0) return 0;
  const resolution = await resolveStoredPage(db, inputs, kind);
  const results = await db.batch(
    batchOf([
      ...pageWrites(db, resolution, kind),
      playInsert(db, resolution.listens),
    ]),
  );
  return (results.at(-1) as unknown[]).length;
}
