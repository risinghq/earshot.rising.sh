import type { Env } from "../types";
import { distinctAnswers, interleave, type Category } from "./catalog";
import { dedupePool, type PoolRow } from "./pool";
import { answerKey, roundSeconds, roundsPerGame } from "./quiz";
import type { Candidate } from "./sources";

export const forYouSlug = "for-you";

export const forYouCategory: Category = {
  slug: forYouSlug,
  name: "For you",
  feed: "for_you",
  ref: null,
};

const mixTtlSeconds = 600;
const topCells = 5;
const knownTarget = 7;
const newTarget = roundsPerGame - knownTarget;
const spare = 4;
const recentSeconds = 30 * 86400;
const fallbackCategories = 3;
export const coldRounds = 10;

// Same precedence as the category pools: the answer-year override, then the
// decade the source playlist declares, then the release year. The grouped
// form takes the earliest declared decade, as dedupePool keeps one row per
// Deezer id.
const rowDecade = `COALESCE(
  CASE WHEN ct.answer_year > 0 THEN ct.answer_year / 10 * 10 END,
  cs.decade,
  CASE WHEN ct.year > 0 THEN ct.year / 10 * 10 END
)`;
const groupDecade = `COALESCE(
  CASE WHEN ct.answer_year > 0 THEN ct.answer_year / 10 * 10 END,
  MIN(cs.decade),
  CASE WHEN ct.year > 0 THEN ct.year / 10 * 10 END
)`;
const candidateCols = `ct.deezer_id,
       COALESCE(ct.answer_title, ct.title) AS title,
       ct.artist, ct.cover, ct.link,
       COALESCE(ct.answer_year, ct.year) AS year`;

interface Cell {
  category: string;
  era: number | null;
  score: number;
}

interface OutcomeCellRow {
  category: string;
  era: number | null;
  played: number;
  rate: number;
  ms: number;
}

function outcomeCells(db: D1Database, playerKey: string) {
  return db
    .prepare(
      `SELECT category, era, COUNT(*) AS played,
              AVG(correct) AS rate, AVG(elapsed_ms) AS ms
       FROM round_outcomes
       WHERE player_key = ?1
       GROUP BY category, era`,
    )
    .bind(playerKey)
    .all<OutcomeCellRow>()
    .then((rows) => rows.results);
}

// A signed-in player's listening teaches the mix where their artists live:
// the artists of the same top tracks the "From my listening" category plays,
// counted at every (category, decade) cell they occupy in the catalog.
function listeningCells(db: D1Database, userId: number) {
  return db
    .prepare(
      `SELECT cs.category AS category, ${rowDecade} AS era, COUNT(*) AS weight
       FROM (
         SELECT tracks.artist_id
         FROM track_totals
         JOIN tracks ON tracks.id = track_totals.track_id
         WHERE track_totals.user_id = ?1
         ORDER BY track_totals.plays DESC
         LIMIT 40
       ) top
       JOIN artists ON artists.id = top.artist_id
       JOIN catalog_tracks ct ON LOWER(ct.artist) = LOWER(artists.name)
       JOIN catalog_members cm ON cm.deezer_id = ct.deezer_id
       JOIN category_sources cs ON cs.id = cm.source_id
       JOIN categories ON categories.slug = cs.category
       WHERE categories.hidden = 0
       GROUP BY cs.category, era`,
    )
    .bind(userId)
    .all<{ category: string; era: number | null; weight: number }>()
    .then((rows) => rows.results);
}

function playlistCategories(db: D1Database) {
  return db
    .prepare(
      `SELECT slug FROM categories
       WHERE hidden = 0 AND feed = 'deezer_playlist'
       ORDER BY position, slug`,
    )
    .all<{ slug: string }>()
    .then((rows) => rows.results.map((row) => row.slug));
}

// Correct rate rewards the cells the player actually knows; answer speed does
// the same, scaled so a slow average still counts something.
function mergeCells(
  outcomes: OutcomeCellRow[],
  listening: { category: string; era: number | null; weight: number }[],
  playable: string[],
) {
  const keep = new Set(playable);
  const map = new Map<string, Cell>();
  const bump = (category: string, era: number | null, score: number) => {
    if (!keep.has(category)) return;
    const key = `${category}${era ?? "*"}`;
    const cell = map.get(key) ?? { category, era, score: 0 };
    cell.score += score;
    map.set(key, cell);
  };
  for (const row of outcomes) {
    const speed =
      1 - Math.min(row.ms, roundSeconds * 1000) / (roundSeconds * 1000);
    bump(row.category, row.era, row.played * (0.5 + row.rate) * (0.5 + speed));
  }
  for (const row of listening) bump(row.category, row.era, row.weight);
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, topCells);
}

// Known tracks are unbanned catalog rows from the player's top cells that the
// player has not answered in the last 30 days. A cell without an era — a
// chart or artist game, or a track without a year — means the whole category.
function knownCandidates(
  db: D1Database,
  playerKey: string,
  cells: Cell[],
  since: number,
) {
  if (cells.length === 0) return Promise.resolve([] as Candidate[]);
  let next = 3;
  const clauses = cells
    .map((cell) =>
      cell.era === null
        ? `cs.category = ?${next++}`
        : `(cs.category = ?${next++} AND ${rowDecade} = ?${next++})`,
    )
    .join(" OR ");
  const binds: (string | number)[] = [playerKey, since];
  for (const cell of cells) {
    binds.push(cell.category);
    if (cell.era !== null) binds.push(cell.era);
  }
  return db
    .prepare(
      `SELECT ${candidateCols}, ${rowDecade} AS decade,
              cs.category AS category
       FROM category_sources cs
       JOIN catalog_members cm ON cm.source_id = cs.id
       JOIN catalog_tracks ct ON ct.deezer_id = cm.deezer_id
       JOIN categories ON categories.slug = cs.category AND categories.hidden = 0
       WHERE ct.banned_at IS NULL
         AND ct.deezer_id NOT IN (
           SELECT deezer_id FROM round_outcomes
           WHERE player_key = ?1 AND deezer_id IS NOT NULL
             AND answered_at > ?2
         )
         AND (${clauses})
       ORDER BY cs.position, cs.id, cm.position
       LIMIT 80`,
    )
    .bind(...binds)
    .all<PoolRow>()
    .then((rows) => dedupePool(rows.results));
}

// New tracks share a source playlist with tracks the player answered
// correctly, and are ranked by how many of those tracks they sit beside.
function newCandidates(db: D1Database, playerKey: string) {
  return db
    .prepare(
      `SELECT ${candidateCols}, ${groupDecade} AS decade,
              MIN(cs.category) AS category,
              COUNT(DISTINCT ro.deezer_id) AS shared
       FROM round_outcomes ro
       JOIN catalog_members seed ON seed.deezer_id = ro.deezer_id
       JOIN catalog_members cm ON cm.source_id = seed.source_id
       JOIN catalog_tracks ct ON ct.deezer_id = cm.deezer_id
       JOIN category_sources cs ON cs.id = cm.source_id
       JOIN categories ON categories.slug = cs.category AND categories.hidden = 0
       WHERE ro.player_key = ?1
         AND ro.correct = 1
         AND ro.deezer_id IS NOT NULL
         AND ct.banned_at IS NULL
         AND ct.deezer_id NOT IN (
           SELECT deezer_id FROM round_outcomes
           WHERE player_key = ?1 AND deezer_id IS NOT NULL
         )
       GROUP BY ct.deezer_id
       ORDER BY shared DESC, MIN(cs.position), MIN(cs.id), MIN(cm.position)
       LIMIT 40`,
    )
    .bind(playerKey)
    .all<PoolRow>()
    .then((rows) => dedupePool(rows.results));
}

// The pool the mix falls back to: the union of the most-played categories'
// catalogs, all eras, or the first categories by position when nobody has
// played yet.
async function fallbackPool(
  db: D1Database,
  playerKey: string,
  since: number,
  playlists: string[],
) {
  const played = await db
    .prepare(
      `SELECT ro.category AS slug
       FROM round_outcomes ro
       JOIN categories ON categories.slug = ro.category
       WHERE categories.hidden = 0 AND categories.feed = 'deezer_playlist'
       GROUP BY ro.category
       ORDER BY COUNT(*) DESC, ro.category
       LIMIT ${fallbackCategories}`,
    )
    .all<{ slug: string }>();
  const slugs = played.results.map((row) => row.slug);
  for (const slug of playlists) {
    if (slugs.length >= fallbackCategories) break;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  if (slugs.length === 0) return [] as Candidate[];
  const marks = slugs.map((_, index) => `?${index + 3}`).join(", ");
  const rows = await db
    .prepare(
      `SELECT ${candidateCols}, ${groupDecade} AS decade,
              MIN(cs.category) AS category
       FROM category_sources cs
       JOIN catalog_members cm ON cm.source_id = cs.id
       JOIN catalog_tracks ct ON ct.deezer_id = cm.deezer_id
       WHERE cs.category IN (${marks})
         AND ct.banned_at IS NULL
         AND ct.deezer_id NOT IN (
           SELECT deezer_id FROM round_outcomes
           WHERE player_key = ?1 AND deezer_id IS NOT NULL
             AND answered_at > ?2
         )
       GROUP BY ct.deezer_id
       ORDER BY MIN(cs.position), MIN(cs.id), MIN(cm.position)`,
    )
    .bind(playerKey, since, ...slugs)
    .all<PoolRow>();
  return dedupePool(rows.results);
}

// A round's choices need different answers, so a title already picked — even
// by another artist — is skipped.
function takeDistinct(pools: Candidate[][], count: number, seen: Set<string>) {
  const picked: Candidate[] = [];
  for (const pool of pools) {
    for (const track of pool) {
      if (picked.length === count) return picked;
      const key = answerKey(track.title);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      picked.push(track);
    }
  }
  return picked;
}

// The cached mix predates any ban, correction or source refresh that landed
// since it was computed: catalog invalidation only drops play:cat:* keys and
// cannot enumerate per-player keys. Re-reading the catalog rows for the
// cached ids on a hit keeps bans and answer overrides current; when too few
// tracks survive, the mix is rebuilt instead.
async function revalidate(db: D1Database, cached: Candidate[]) {
  const ids = cached
    .map((track) => track.deezerId)
    .filter((id): id is number => id !== undefined);
  if (ids.length === 0) return null;
  const marks = ids.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await db
    .prepare(
      `SELECT ${candidateCols}, ${rowDecade} AS decade,
              cs.category AS category
       FROM catalog_tracks ct
       JOIN catalog_members cm ON cm.deezer_id = ct.deezer_id
       JOIN category_sources cs ON cs.id = cm.source_id
       JOIN categories ON categories.slug = cs.category AND categories.hidden = 0
       WHERE ct.banned_at IS NULL AND ct.deezer_id IN (${marks})`,
    )
    .bind(...ids)
    .all<PoolRow>();
  const live = new Map<string, PoolRow>();
  for (const row of rows.results)
    live.set(`${row.deezer_id}:${row.category}`, row);
  const seen = new Set<string>();
  const tracks: Candidate[] = [];
  for (const track of cached) {
    const row = live.get(`${track.deezerId}:${track.category}`);
    if (row === undefined) continue;
    const key = answerKey(row.title);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      ...track,
      title: row.title,
      artist: row.artist,
      cover: row.cover,
      link: row.link,
      year: row.year ?? undefined,
      decade: row.decade ?? undefined,
    });
  }
  return distinctAnswers(tracks) >= roundsPerGame ? tracks : null;
}

export async function forYouCold(
  db: D1Database,
  playerKey: string,
  userId: number | null,
) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS played FROM round_outcomes WHERE player_key = ?1",
    )
    .bind(playerKey)
    .first<{ played: number }>();
  if ((row?.played ?? 0) >= coldRounds) return false;
  if (userId === null) return true;
  return (await listeningCells(db, userId)).length === 0;
}

export async function forYouMix(
  env: Env,
  playerKey: string,
  userId: number | null,
): Promise<Candidate[]> {
  const key = `play:foryou:${playerKey}`;
  const cached = await env.CACHE?.get<Candidate[]>(key, "json").catch(
    () => null,
  );
  if (cached && cached.length > 0) {
    const live = await revalidate(env.DB, cached);
    if (live !== null) return live;
  }
  const db = env.DB;
  const since = Math.floor(Date.now() / 1000) - recentSeconds;
  const [outcomes, listening, playlists] = await Promise.all([
    outcomeCells(db, playerKey),
    userId === null ? Promise.resolve([]) : listeningCells(db, userId),
    playlistCategories(db),
  ]);
  const fallback = await fallbackPool(db, playerKey, since, playlists);
  const rounds = outcomes.reduce((total, row) => total + row.played, 0);
  const seen = new Set<string>();
  let tracks: Candidate[];
  if (rounds < coldRounds && listening.length === 0) {
    tracks = takeDistinct([fallback], roundsPerGame + spare, seen);
  } else {
    const cells = mergeCells(outcomes, listening, playlists);
    const [knownPool, newPool] = await Promise.all([
      knownCandidates(db, playerKey, cells, since),
      newCandidates(db, playerKey),
    ]);
    const known = takeDistinct([knownPool, fallback], knownTarget, seen);
    const fresh = takeDistinct([newPool, knownPool, fallback], newTarget, seen);
    const extra = takeDistinct([knownPool, newPool, fallback], spare, seen);
    tracks = interleave([known, fresh, extra]);
  }
  if (env.CACHE && tracks.length > 0)
    await env.CACHE.put(key, JSON.stringify(tracks), {
      expirationTtl: mixTtlSeconds,
    }).catch(() => undefined);
  return tracks;
}
