import { eq, inArray, notExists, sql } from "drizzle-orm";
import { t, type Db } from "../platform/db";
import { sourcesOf } from "../listening/totals";

export function deletionStatements(db: Db, userId: number) {
  return [
    db.delete(t.plays).where(eq(t.plays.userId, userId)),
    db.delete(t.trackTotals).where(eq(t.trackTotals.userId, userId)),
    db.delete(t.dailyTotals).where(eq(t.dailyTotals.userId, userId)),
    db.delete(t.artistTotals).where(eq(t.artistTotals.userId, userId)),
    db
      .delete(t.tokens)
      .where(inArray(t.tokens.sourceId, sourcesOf(db, userId))),
    db.delete(t.sources).where(eq(t.sources.userId, userId)),
    db.delete(t.sessions).where(eq(t.sessions.userId, userId)),
    db.delete(t.users).where(eq(t.users.id, userId)),
    // The cascade above can empty a group the deleted user did not make.
    db.delete(t.friendGroups).where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(t.groupMembers)
          .where(eq(t.groupMembers.groupId, t.friendGroups.id)),
      ),
    ),
  ] as const;
}
