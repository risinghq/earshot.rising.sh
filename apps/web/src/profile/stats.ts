import { and, count, countDistinct, desc, eq, gte, sql } from "drizzle-orm";
import { t, type Db } from "../platform/db";

export type Period = "week" | "month" | "all";

export interface PeriodStats {
  schema: 1;
  user: { name: string };
  period: Period;
  from: number | null;
  to: number;
  plays: number;
  unique_tracks: number;
  unique_artists: number;
  top_tracks: Array<{
    title: string;
    artist: string;
    plays: number;
    image: string | null;
  }>;
  top_artists: Array<{ artist: string; plays: number; image: string | null }>;
  daily: Array<{ day: string; plays: number }>;
  updated_at: number;
}

const { plays: p, tracks: tr, artists: ar } = t;

function periodStart(period: Period, now: number) {
  if (period === "week") return now - 7 * 86400;
  if (period === "month") return now - 30 * 86400;
  return null;
}

function dayText(dayNumber: number) {
  return new Date(dayNumber * 86400_000).toISOString().slice(0, 10);
}

// All time reads the totals tables the ingest keeps, so it costs the same for
// any length of history.
function allTime(db: Db, userId: number) {
  const tt = t.trackTotals;
  const at = t.artistTotals;
  const dt = t.dailyTotals;
  return db.batch([
    db
      .select({
        title: tr.title,
        artist: ar.name,
        plays: tt.plays,
        image: tr.image,
      })
      .from(tt)
      .innerJoin(tr, eq(tr.id, tt.trackId))
      .innerJoin(ar, eq(ar.id, tr.artistId))
      .where(eq(tt.userId, userId))
      .orderBy(desc(tt.plays), tt.trackId)
      .limit(10),
    db
      .select({ artist: ar.name, plays: at.plays, image: ar.image })
      .from(at)
      .innerJoin(ar, eq(ar.id, at.artistId))
      .where(eq(at.userId, userId))
      .orderBy(desc(at.plays), at.artistId)
      .limit(10),
    db
      .select({
        plays: sql<number | null>`sum(${tt.plays})`,
        uniqueTracks: count(),
        uniqueArtists: sql<number>`(${db
          .select({ n: count() })
          .from(at)
          .where(eq(at.userId, userId))})`,
      })
      .from(tt)
      .where(eq(tt.userId, userId)),
    db
      .select({ day: dt.day, plays: dt.plays })
      .from(dt)
      .where(eq(dt.userId, userId))
      .orderBy(dt.day),
  ]);
}

function sinceTime(db: Db, userId: number, from: number) {
  const counted = and(
    eq(p.userId, userId),
    eq(p.dup, 0),
    gte(p.playedAt, from),
  );
  const day = sql<number>`${p.playedAt} / 86400`;
  return db.batch([
    db
      .select({
        title: tr.title,
        artist: ar.name,
        plays: count(),
        image: tr.image,
      })
      .from(p)
      .innerJoin(tr, eq(tr.id, p.trackId))
      .innerJoin(ar, eq(ar.id, tr.artistId))
      .where(counted)
      .groupBy(p.trackId)
      .orderBy(desc(count()), tr.id)
      .limit(10),
    db
      .select({ artist: ar.name, plays: count(), image: ar.image })
      .from(p)
      .innerJoin(tr, eq(tr.id, p.trackId))
      .innerJoin(ar, eq(ar.id, tr.artistId))
      .where(counted)
      .groupBy(ar.id)
      .orderBy(desc(count()), ar.id)
      .limit(10),
    db
      .select({
        plays: count(),
        uniqueTracks: countDistinct(p.trackId),
        uniqueArtists: countDistinct(tr.artistId),
      })
      .from(p)
      .innerJoin(tr, eq(tr.id, p.trackId))
      .where(counted),
    db
      .select({ day, plays: count() })
      .from(p)
      .where(counted)
      .groupBy(day)
      .orderBy(day),
  ]);
}

export async function getStats(
  db: Db,
  userId: number,
  name: string,
  period: Period,
  now: number,
) {
  const from = periodStart(period, now);
  const [tracks, artists, [total], daily] =
    from === null
      ? await allTime(db, userId)
      : await sinceTime(db, userId, from);
  return {
    schema: 1,
    user: { name },
    period,
    from,
    to: now,
    plays: total?.plays ?? 0,
    unique_tracks: total?.uniqueTracks ?? 0,
    unique_artists: total?.uniqueArtists ?? 0,
    top_tracks: tracks,
    top_artists: artists,
    daily: daily.map((row) => ({ day: dayText(row.day), plays: row.plays })),
    updated_at: now,
  } satisfies PeriodStats;
}
