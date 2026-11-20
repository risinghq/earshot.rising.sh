import { normalizeText } from "../normalize";
import { answerKey } from "./quiz";
import type { Candidate } from "./sources";

// A decade a category offers as its own game needs enough distinct songs to
// fill a 10-round game without repeats feeling cheap.
export const eraMinTracks = 20;

export function decadeOf(year: number | null | undefined) {
  return typeof year === "number" && year > 0
    ? Math.floor(year / 10) * 10
    : null;
}

export interface PoolRow {
  track_key: string;
  deezer_id: number | null;
  title: string;
  original_title?: string | null;
  artist: string;
  cover: string | null;
  link: string | null;
  preview?: string | null;
  year: number | null;
  decade: number | null;
  category?: string | null;
}

// The pool is the union of a category's sources. The same recording can sit
// in two playlists under one track key, and two keys can be the same answer —
// a single and the album cut — so rows dedupe on the key first, then on the
// answer title per artist.
export function dedupePool(rows: PoolRow[]): Candidate[] {
  const seenKeys = new Set<string>();
  const seenAnswers = new Set<string>();
  const pool: Candidate[] = [];
  for (const row of rows) {
    if (seenKeys.has(row.track_key)) continue;
    const answer = `${normalizeText(row.artist)}|${answerKey(row.title)}`;
    if (seenAnswers.has(answer)) continue;
    seenKeys.add(row.track_key);
    seenAnswers.add(answer);
    const itunes = /^it:(\d+)$/.exec(row.track_key);
    pool.push({
      title: row.title,
      ...(row.original_title ? { original: row.original_title } : {}),
      artist: row.artist,
      cover: row.cover,
      link: row.link,
      ...(row.deezer_id === null ? {} : { deezerId: row.deezer_id }),
      ...(itunes ? { itunesId: Number(itunes[1]) } : {}),
      ...(row.preview ? { preview: row.preview } : {}),
      year: row.year ?? undefined,
      decade: row.decade ?? undefined,
      category: row.category ?? undefined,
    });
  }
  return pool;
}

export async function catalogPool(db: D1Database, category: string) {
  const rows = await db
    .prepare(
      `SELECT ct.track_key, ct.deezer_id,
              COALESCE(ct.answer_title, ct.title) AS title,
              CASE WHEN ct.answer_title IS NULL THEN ct.original_title END
                AS original_title,
              ct.artist, ct.cover, ct.link, ct.preview,
              COALESCE(ct.answer_year, ct.year) AS year,
              COALESCE(
                CASE WHEN ct.answer_year > 0
                     THEN ct.answer_year / 10 * 10 END,
                MIN(cs.decade),
                CASE WHEN ct.year > 0 THEN ct.year / 10 * 10 END
              ) AS decade
       FROM category_sources cs
       JOIN catalog_members cm ON cm.source_id = cs.id
       JOIN catalog_tracks ct ON ct.track_key = cm.track_key
       WHERE cs.category = ?1 AND ct.banned_at IS NULL
       GROUP BY ct.track_key
       ORDER BY MIN(cs.position), MIN(cs.id), MIN(cm.position)`,
    )
    .bind(category)
    .all<PoolRow>();
  return dedupePool(rows.results);
}

// A catalog track's decade is its answer-year override, then the decade its
// source playlist declares, then its release year.
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
