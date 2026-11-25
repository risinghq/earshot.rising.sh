import { and, count, eq, sql } from "drizzle-orm";
import { t, type Db } from "../platform/db";

// SQL triggers keep the totals tables in step with inserted plays and dup
// flips, but no trigger runs on a delete. Removing plays rebuilds the user's
// totals from the plays left, by the same rule the triggers follow.

// Counted plays: a duplicate stays in plays but in no total.
const countedPlays = (userId: number) =>
  and(eq(t.plays.userId, userId), eq(t.plays.dup, 0));

const playDay = sql<number>`${t.plays.playedAt} / 86400`;

function recountStatements(db: Db, userId: number) {
  return [
    db.delete(t.trackTotals).where(eq(t.trackTotals.userId, userId)),
    db.insert(t.trackTotals).select(
      db
        .select({
          userId: t.plays.userId,
          trackId: t.plays.trackId,
          plays: count().as("plays"),
          lastPlayedAt: sql<number>`max(${t.plays.playedAt})`.as(
            "last_played_at",
          ),
        })
        .from(t.plays)
        .where(countedPlays(userId))
        .groupBy(t.plays.trackId),
    ),
    db.delete(t.dailyTotals).where(eq(t.dailyTotals.userId, userId)),
    db.insert(t.dailyTotals).select(
      db
        .select({
          userId: t.plays.userId,
          day: playDay.as("day"),
          plays: count().as("plays"),
        })
        .from(t.plays)
        .where(countedPlays(userId))
        .groupBy(playDay),
    ),
    db.delete(t.artistTotals).where(eq(t.artistTotals.userId, userId)),
    db.insert(t.artistTotals).select(
      db
        .select({
          userId: t.plays.userId,
          artistId: t.tracks.artistId,
          plays: count().as("plays"),
        })
        .from(t.plays)
        .innerJoin(t.tracks, eq(t.tracks.id, t.plays.trackId))
        .where(countedPlays(userId))
        .groupBy(t.tracks.artistId),
    ),
  ] as const;
}

export function sourceRemovalStatements(
  db: Db,
  userId: number,
  sourceId: number,
) {
  return [
    db
      .delete(t.plays)
      .where(and(eq(t.plays.userId, userId), eq(t.plays.sourceId, sourceId))),
    db.delete(t.tokens).where(eq(t.tokens.sourceId, sourceId)),
    db
      .delete(t.sources)
      .where(and(eq(t.sources.id, sourceId), eq(t.sources.userId, userId))),
    ...recountStatements(db, userId),
  ] as const;
}

export const sourcesOf = (db: Db, userId: number) =>
  db
    .select({ id: t.sources.id })
    .from(t.sources)
    .where(eq(t.sources.userId, userId));
