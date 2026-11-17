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
  deezer_id: number;
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  year: number | null;
  decade: number | null;
  category?: string | null;
}

// The pool is the union of a category's sources. The same recording can sit
// in two playlists under one Deezer id, and two ids can be the same answer —
// a single and the album cut — so rows dedupe on the id first, then on the
// answer title per artist.
export function dedupePool(rows: PoolRow[]): Candidate[] {
  const seenIds = new Set<number>();
  const seenAnswers = new Set<string>();
  const pool: Candidate[] = [];
  for (const row of rows) {
    if (seenIds.has(row.deezer_id)) continue;
    const answer = `${normalizeText(row.artist)}|${answerKey(row.title)}`;
    if (seenAnswers.has(answer)) continue;
    seenIds.add(row.deezer_id);
    seenAnswers.add(answer);
    pool.push({
      title: row.title,
      artist: row.artist,
      cover: row.cover,
      link: row.link,
      deezerId: row.deezer_id,
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
      `SELECT ct.deezer_id,
              COALESCE(ct.answer_title, ct.title) AS title,
              ct.artist, ct.cover, ct.link,
              COALESCE(ct.answer_year, ct.year) AS year,
              COALESCE(
                CASE WHEN ct.answer_year > 0
                     THEN ct.answer_year / 10 * 10 END,
                MIN(cs.decade),
                CASE WHEN ct.year > 0 THEN ct.year / 10 * 10 END
              ) AS decade
       FROM category_sources cs
       JOIN catalog_members cm ON cm.source_id = cs.id
       JOIN catalog_tracks ct ON ct.deezer_id = cm.deezer_id
       WHERE cs.category = ?1 AND ct.banned_at IS NULL
       GROUP BY ct.deezer_id
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
