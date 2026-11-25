import { and, eq, sql } from "drizzle-orm";
import { t, type Db } from "../platform/db";

export const exportPageSize = 1000;

// One page of the export, after a (played_at, source_id, ref) key. The keys
// are the export file's field names; source_id only orders the pages.
export function exportPage(
  db: Db,
  userId: number,
  after: [number, number, string],
) {
  const [playedAt, sourceId, ref] = after;
  return db
    .select({
      played_at: t.plays.playedAt,
      source_id: t.plays.sourceId,
      source: t.sources.kind,
      ref: t.plays.ref,
      artist: t.artists.name,
      title: t.tracks.title,
    })
    .from(t.plays)
    .innerJoin(t.sources, eq(t.sources.id, t.plays.sourceId))
    .innerJoin(t.tracks, eq(t.tracks.id, t.plays.trackId))
    .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
    .where(
      and(
        eq(t.plays.userId, userId),
        sql`(${t.plays.playedAt}, ${t.plays.sourceId}, ${t.plays.ref}) > (${playedAt}, ${sourceId}, ${ref})`,
      ),
    )
    .orderBy(t.plays.playedAt, t.plays.sourceId, t.plays.ref)
    .limit(exportPageSize);
}
