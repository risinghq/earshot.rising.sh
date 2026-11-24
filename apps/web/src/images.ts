import {
  and,
  desc,
  eq,
  isNull,
  lt,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { batchWrites, database, t, type Db } from "./db";
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

function selectDue(
  db: Db,
  kind: Kind,
  where: SQL | undefined,
  order: SQL | AnyColumn,
  limit: number,
): Promise<Due[]> {
  if (kind === "tracks")
    return db
      .select({ id: t.tracks.id, name: t.tracks.title, artist: t.artists.name })
      .from(t.tracks)
      .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
      .where(where)
      .orderBy(order)
      .limit(limit);
  return db
    .select({ id: t.artists.id, name: t.artists.name, artist: sql<null>`NULL` })
    .from(t.artists)
    .where(where)
    .orderBy(order)
    .limit(limit);
}

// Rows never looked up come first, newest first; then misses old enough to
// try again, oldest lookup first.
async function dueRows(db: Db, kind: Kind, now: number) {
  const table = t[kind];
  const fresh = await selectDue(
    db,
    kind,
    isNull(table.imageAt),
    desc(table.id),
    imagesPerTick,
  );
  const left = imagesPerTick - fresh.length;
  if (left === 0) return fresh;
  const miss = await selectDue(
    db,
    kind,
    and(isNull(table.image), lt(table.imageAt, now - missRetrySeconds)),
    table.imageAt,
    left,
  );
  return [...fresh, ...miss];
}

function imageUpdate(
  db: Db,
  kind: Kind,
  id: number,
  image: string | null,
  now: number,
) {
  const table = kind === "tracks" ? t.tracks : t.artists;
  return db.update(table).set({ image, imageAt: now }).where(eq(table.id, id));
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
  const db = database(env.DB);
  for (const kind of ["tracks", "artists"] as const) {
    const updates: BatchItem<"sqlite">[] = [];
    for (const row of await dueRows(db, kind, now)) {
      let image: string | null;
      try {
        image = await lookUp(kind, row);
      } catch (error) {
        if (error instanceof QuotaError) break;
        continue;
      }
      updates.push(imageUpdate(db, kind, row.id, image, now));
    }
    await batchWrites(db, updates);
  }
}
