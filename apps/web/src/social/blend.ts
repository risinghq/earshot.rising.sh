import { and, count, desc, eq, gte, min, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Env } from "../env";
import { database, t, type Db } from "../platform/db";
import { blend, type PartyTrack, type PartyUser } from "./party-blend";

const recentDays = 90;
const playlistLength = 25;
const cacheSeconds = 600;

export interface BlendMember {
  id: number;
  name: string;
}

function candidateFields(trackId: SQLiteColumn) {
  return {
    title: t.tracks.title,
    artist: t.artists.name,
    artistId: t.tracks.artistId,
    image: t.tracks.image,
    videoId: sql<string | null>`(SELECT ${min(t.trackAliases.sourceKey)}
      FROM ${t.trackAliases}
      WHERE ${t.trackAliases.kind} = 'ytmusic'
        AND ${t.trackAliases.trackId} = ${trackId})`,
  };
}

function recentTracks(db: Db, userId: number, since: number) {
  const plays = count();
  return db
    .select({
      trackId: t.plays.trackId,
      plays,
      ...candidateFields(t.plays.trackId),
    })
    .from(t.plays)
    .innerJoin(t.tracks, eq(t.tracks.id, t.plays.trackId))
    .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
    .where(
      and(
        eq(t.plays.userId, userId),
        eq(t.plays.dup, 0),
        gte(t.plays.playedAt, since),
      ),
    )
    .groupBy(t.plays.trackId)
    .orderBy(desc(plays), t.plays.trackId)
    .limit(playlistLength);
}

function allTimeTracks(db: Db, userId: number) {
  return db
    .select({
      trackId: t.trackTotals.trackId,
      plays: t.trackTotals.plays,
      ...candidateFields(t.trackTotals.trackId),
    })
    .from(t.trackTotals)
    .innerJoin(t.tracks, eq(t.tracks.id, t.trackTotals.trackId))
    .innerJoin(t.artists, eq(t.artists.id, t.tracks.artistId))
    .where(eq(t.trackTotals.userId, userId))
    .orderBy(desc(t.trackTotals.plays), t.trackTotals.trackId)
    .limit(playlistLength);
}

async function buildPlaylist(db: Db, members: BlendMember[], now: number) {
  const since = now - recentDays * 86400;
  const [first, ...rest] = members.flatMap((member) => [
    recentTracks(db, member.id, since),
    allTimeTracks(db, member.id),
  ]);
  if (first === undefined) return [];
  const results = await db.batch([first, ...rest]);
  const users: PartyUser[] = members.map((member, index) => {
    const recent = results[2 * index] ?? [];
    const allTime = results[2 * index + 1] ?? [];
    const seen = new Set(recent.map((row) => row.trackId));
    const tracks = [
      ...recent,
      ...allTime.filter((row) => !seen.has(row.trackId)),
    ]
      .slice(0, playlistLength)
      .map((row, rank) => ({
        trackId: row.trackId,
        title: row.title,
        artist: row.artist,
        artistKey: String(row.artistId),
        videoId: row.videoId,
        image: row.image,
        // Shared ranking sums 90-day counts, so fill rows count as 0.
        plays: rank < recent.length ? row.plays : 0,
      }));
    return { name: member.name, tracks };
  });
  return blend(users, playlistLength);
}

// The key names every member, so a join or a leave builds a new blend at once;
// plays reach an unchanged group's blend within cacheSeconds.
export async function groupPlaylist(
  env: Env,
  groupId: number,
  members: BlendMember[],
) {
  const ids = members
    .map((member) => member.id)
    .sort((a, b) => a - b)
    .join("-");
  const key = `group:${groupId}:${ids}`;
  let items = await env.CACHE.get<PartyTrack[]>(key, "json").catch(() => null);
  if (items === null) {
    items = await buildPlaylist(
      database(env.DB),
      members,
      Math.floor(Date.now() / 1000),
    );
    await env.CACHE.put(key, JSON.stringify(items), {
      expirationTtl: cacheSeconds,
    }).catch(() => undefined);
  }
  return items;
}
