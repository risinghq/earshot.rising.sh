import { and, eq, isNull, min, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { t, type Db } from "../../platform/db";
import { normalizeText } from "../../listening/normalize";
import { answerKey, isVersion } from "../game/quiz";
import type { Candidate } from "./sources";

// A decade a category offers as its own game needs enough distinct songs to
// fill a 10-round game without repeats feeling cheap.
export const eraMinTracks = 20;

export function decadeOf(year: number | null | undefined) {
  return typeof year === "number" && year > 0
    ? Math.floor(year / 10) * 10
    : null;
}

const ct = t.catalogTracks;
const cs = t.categorySources;
const cm = t.catalogMembers;

// A catalog track's decade: the answer-year override, then the decade its
// source playlist declares, then the release year.
function catalogDecade(declared: SQL | SQLiteColumn) {
  return sql<number | null>`COALESCE(
    CASE WHEN ${ct.answerYear} > 0 THEN ${ct.answerYear} / 10 * 10 END,
    ${declared},
    CASE WHEN ${ct.year} > 0 THEN ${ct.year} / 10 * 10 END
  )`;
}

// One row per catalog membership.
export const rowDecade = () => catalogDecade(cs.decade);

// One row per track grouped over its sources: the earliest declared decade,
// as dedupePool keeps one row per Deezer id.
export const groupDecade = () => catalogDecade(min(cs.decade));

// A track as a round plays it, with the answer overrides applied.
export function poolFields() {
  return {
    trackKey: ct.trackKey,
    deezerId: ct.deezerId,
    title: sql<string>`COALESCE(${ct.answerTitle}, ${ct.title})`,
    originalTitle: sql<
      string | null
    >`CASE WHEN ${ct.answerTitle} IS NULL THEN ${ct.originalTitle} END`,
    artist: ct.artist,
    cover: ct.cover,
    link: ct.link,
    preview: ct.preview,
    year: sql<number | null>`COALESCE(${ct.answerYear}, ${ct.year})`,
  };
}

export interface PoolRow {
  trackKey: string;
  deezerId: number | null;
  title: string;
  originalTitle: string | null;
  artist: string;
  cover: string | null;
  link: string | null;
  preview: string | null;
  year: number | null;
  decade: number | null;
  category?: string | null;
}

// The pool is the union of a category's sources. The same recording can sit
// in two playlists under one track key, and two keys can be the same answer —
// a single and the album cut — so rows dedupe on the key first, then on the
// answer title per artist.
// An artist's Deezer top list holds every release of a song: the single, its
// English and Japanese versions, remixes and instrumentals. A round asks for
// the title, so each song plays once, as its plainest release (the first with
// no version clause, else the first) in the place where the song first ranks.
export function songsOnce(tracks: Candidate[]): Candidate[] {
  const chosen = new Map<string, Candidate>();
  for (const track of tracks) {
    const key = answerKey(track.title) || track.title;
    const held = chosen.get(key);
    if (
      held === undefined ||
      (isVersion(held.title) && !isVersion(track.title))
    )
      chosen.set(key, track);
  }
  return [...chosen.values()];
}

export function dedupePool(rows: PoolRow[]): Candidate[] {
  const seenKeys = new Set<string>();
  const seenAnswers = new Set<string>();
  const pool: Candidate[] = [];
  for (const row of rows) {
    if (seenKeys.has(row.trackKey)) continue;
    const answer = `${normalizeText(row.artist)}|${answerKey(row.title)}`;
    if (seenAnswers.has(answer)) continue;
    seenKeys.add(row.trackKey);
    seenAnswers.add(answer);
    const itunes = /^it:(\d+)$/.exec(row.trackKey);
    pool.push({
      title: row.title,
      ...(row.originalTitle ? { original: row.originalTitle } : {}),
      artist: row.artist,
      cover: row.cover,
      link: row.link,
      ...(row.deezerId === null ? {} : { deezerId: row.deezerId }),
      ...(itunes ? { itunesId: Number(itunes[1]) } : {}),
      ...(row.preview ? { preview: row.preview } : {}),
      year: row.year ?? undefined,
      decade: row.decade ?? undefined,
      category: row.category ?? undefined,
    });
  }
  return pool;
}

export async function catalogPool(db: Db, category: string) {
  const rows = await db
    .select({ ...poolFields(), decade: groupDecade() })
    .from(cs)
    .innerJoin(cm, eq(cm.sourceId, cs.id))
    .innerJoin(ct, eq(ct.trackKey, cm.trackKey))
    .where(and(eq(cs.category, category), isNull(ct.bannedAt)))
    .groupBy(ct.trackKey)
    .orderBy(min(cs.position), min(cs.id), min(cm.position));
  return dedupePool(rows);
}

// The decade catalogDecade gave the track, else its release year's.
export function trackDecade(track: Candidate) {
  return track.decade ?? decadeOf(track.year);
}

export function byDecade(pool: Candidate[], era: number) {
  return pool.filter((track) => trackDecade(track) === era);
}

// Eras are counted on the deduped pool, so a decade offered on a tile always
// holds enough playable answers.
export function poolEras(pool: Candidate[]) {
  const counts = new Map<number, number>();
  for (const track of pool) {
    const decade = trackDecade(track);
    if (decade !== null) counts.set(decade, (counts.get(decade) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= eraMinTracks)
    .map(([decade]) => decade)
    .sort((a, b) => a - b);
}
