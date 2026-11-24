import { eq, and, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alignPage, type Alignment, type PagePair } from "./align";
import { batchOf, t, type Db } from "./db";
import { markDuplicates } from "./duplicates";
import {
  pageWrites,
  playInsert,
  resolveStoredPage,
  type PageResolution,
} from "./matching";

export const pageSourceFields = {
  id: t.sources.id,
  userId: t.sources.userId,
  status: t.sources.status,
  lastPage: t.sources.lastPage,
  playSeq: t.sources.playSeq,
  gapAt: t.sources.gapAt,
};

export interface PageSource {
  id: number;
  userId: number;
  status: string;
  lastPage: string | null;
  playSeq: number;
  gapAt: number | null;
}

export interface PagePlay {
  day: string;
  artist: string;
  title: string;
  video_id: string;
}

export interface IngestOptions {
  now: number;
  pullNextAt?: number;
  extra?: BatchItem<"sqlite">[];
}

export interface IngestResult {
  received: number;
  inserted: number;
  gap: boolean;
  ambiguous: number;
  replay: boolean;
  raced: boolean;
}

export function uploadListenedAt(play: PagePlay) {
  return Date.parse(`${play.day}T12:00:00.000Z`) / 1000;
}

// A page that adds nothing still proves the source works: a pull moves its
// next pull and clears an error, an upload stamps its last success.
function touchSource(db: Db, source: PageSource, options: IngestOptions) {
  const where = eq(t.sources.id, source.id);
  if (options.pullNextAt !== undefined)
    return db
      .update(t.sources)
      .set({
        nextPullAt: options.pullNextAt,
        error: null,
        idlePulls: 0,
        status: sql`CASE WHEN ${t.sources.status} = 'error' THEN 'active' ELSE ${t.sources.status} END`,
      })
      .where(where);
  return db.update(t.sources).set({ lastOkAt: options.now }).where(where);
}

function pageDayRange(plays: PagePlay[]): [number, number] {
  const times = plays.map(uploadListenedAt);
  return [Math.min(...times), Math.max(...times)];
}

async function resolvePage(
  db: Db,
  source: PageSource,
  added: PagePlay[],
): Promise<PageResolution> {
  const inputs = added
    .map((play) => ({
      kind: "ytmusic",
      sourceKey: play.video_id,
      artist: play.artist,
      title: play.title,
      listenedAt: uploadListenedAt(play),
      userId: source.userId,
      sourceId: source.id,
    }))
    .reverse();
  const empty: PageResolution = { listens: [], newTracks: [] };
  if (inputs.length === 0) return empty;
  return resolveStoredPage(db, inputs, "ytmusic");
}

// The source still holds the play_seq the page was aligned against; a page
// that raced another one changes nothing.
const unchangedSince = (source: PageSource) =>
  and(eq(t.sources.id, source.id), eq(t.sources.playSeq, source.playSeq));

function sourceUpdate(
  db: Db,
  source: PageSource,
  alignment: Alignment,
  added: number,
  pageJson: string,
  options: IngestOptions,
) {
  const page = {
    lastPage: pageJson,
    playSeq: sql`${t.sources.playSeq} + ${added}`,
    maybeMissing: sql`${t.sources.maybeMissing} + ${alignment.ambiguous}`,
    status: alignment.gap ? ("gap" as const) : ("active" as const),
    gapAt: alignment.gap ? options.now : source.gapAt,
  };
  const update =
    options.pullNextAt !== undefined
      ? {
          ...page,
          nextPullAt: options.pullNextAt,
          error: null,
          idlePulls: 0,
          playCount: sql`${t.sources.playCount} + ${added}`,
        }
      : { ...page, lastOkAt: options.now };
  return db.update(t.sources).set(update).where(unchangedSince(source));
}

// The store, gap and duplicate step shared by an upload and a pull: align the
// page against the last accepted one, write the new plays in one batch guarded
// by play_seq, then pair duplicates over the span the page touched.
export async function ingestPage(
  db: Db,
  source: PageSource,
  plays: PagePlay[],
  options: IngestOptions,
): Promise<IngestResult> {
  const pairs: PagePair[] = plays.map((play) => [play.day, play.video_id]);
  const pageJson = JSON.stringify(pairs);
  const extra = options.extra ?? [];

  // An empty page proves nothing about alignment, duplicates or gaps, so it
  // only reschedules the source; alignPage would read a negative run from it.
  if (plays.length === 0) {
    await db.batch([touchSource(db, source, options), ...extra]);
    return {
      received: 0,
      inserted: 0,
      gap: source.status === "gap",
      ambiguous: 0,
      replay: false,
      raced: false,
    };
  }

  if (source.lastPage === pageJson) {
    await markDuplicates(db, source.userId, ...pageDayRange(plays));
    await db.batch([touchSource(db, source, options), ...extra]);
    return {
      received: plays.length,
      inserted: 0,
      gap: source.status === "gap",
      ambiguous: 0,
      replay: true,
      raced: false,
    };
  }

  const previous =
    source.lastPage === null
      ? null
      : (JSON.parse(source.lastPage) as PagePair[]);
  const alignment = alignPage(previous, pairs);
  const added = plays.slice(0, alignment.newCount);
  const resolution = await resolvePage(db, source, added);
  const { listens } = resolution;

  const writes = pageWrites(db, resolution, "ytmusic");
  if (listens.length > 0)
    writes.push(
      playInsert(
        db,
        listens.map((listen, index) => ({
          ...listen,
          ref: `${listen.sourceKey}#${source.playSeq + index + 1}`,
        })),
        sql`(${db
          .select({ playSeq: t.sources.playSeq })
          .from(t.sources)
          .where(eq(t.sources.id, source.id))}) = ${source.playSeq}`,
      ),
    );
  const updateIndex = writes.length;
  const results = await db.batch(
    batchOf([
      ...writes,
      sourceUpdate(db, source, alignment, listens.length, pageJson, options),
      ...extra,
    ]),
  );
  const update = results[updateIndex] as D1Result;
  if (update.meta.changes === 0)
    return {
      received: plays.length,
      inserted: 0,
      gap: alignment.gap,
      ambiguous: alignment.ambiguous,
      replay: false,
      raced: true,
    };

  const times =
    listens.length > 0
      ? listens.map((listen) => listen.listenedAt)
      : pageDayRange(plays);
  await markDuplicates(
    db,
    source.userId,
    Math.min(...times),
    Math.max(...times),
  );
  return {
    received: plays.length,
    inserted: listens.length,
    gap: alignment.gap,
    ambiguous: alignment.ambiguous,
    replay: false,
    raced: false,
  };
}
