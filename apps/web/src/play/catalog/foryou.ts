import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  min,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { database, t, type Db } from "../../platform/db";
import type { Env } from "../../env";
import { distinctAnswers, interleave, type Category } from "./catalog";
import { trackKeyFor } from "../game/outcomes";
import {
  dedupePool,
  groupDecade,
  poolFields,
  rowDecade,
  type PoolRow,
} from "./pool";
import { answerKey, roundSeconds, roundsPerGame } from "../game/quiz";
import { drawWeights, weightedShuffle } from "../game/rating";
import type { Mode } from "../game/rules";
import { workLabel } from "../game/rules";
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

const ct = t.catalogTracks;
const cs = t.categorySources;
const cm = t.catalogMembers;
const ro = t.roundOutcomes;

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

interface ListeningCellRow {
  category: string;
  era: number | null;
  weight: number;
}

function outcomeCells(db: Db, playerKey: string): Promise<OutcomeCellRow[]> {
  return db
    .select({
      category: ro.category,
      era: ro.era,
      played: count(),
      rate: sql<number>`AVG(${ro.correct})`,
      ms: sql<number>`AVG(${ro.elapsedMs})`,
    })
    .from(ro)
    .where(eq(ro.playerKey, playerKey))
    .groupBy(ro.category, ro.era);
}

// A signed-in player's listening teaches the mix where their artists live:
// the artists of the same top tracks the "From my listening" category plays,
// counted at every (category, decade) cell they occupy in the catalog.
function listeningCells(db: Db, userId: number): Promise<ListeningCellRow[]> {
  const top = db
    .select({ artistId: t.tracks.artistId })
    .from(t.trackTotals)
    .innerJoin(t.tracks, eq(t.tracks.id, t.trackTotals.trackId))
    .where(eq(t.trackTotals.userId, userId))
    .orderBy(desc(t.trackTotals.plays))
    .limit(40)
    .as("top");
  return db
    .select({ category: cs.category, era: rowDecade(), weight: count() })
    .from(top)
    .innerJoin(t.artists, eq(t.artists.id, top.artistId))
    .innerJoin(ct, sql`LOWER(${ct.artist}) = LOWER(${t.artists.name})`)
    .innerJoin(cm, eq(cm.trackKey, ct.trackKey))
    .innerJoin(cs, eq(cs.id, cm.sourceId))
    .innerJoin(t.categories, eq(t.categories.slug, cs.category))
    .where(eq(t.categories.hidden, 0))
    .groupBy(cs.category, rowDecade());
}

const visiblePlaylist = and(
  eq(t.categories.hidden, 0),
  eq(t.categories.feed, "deezer_playlist"),
);

function playlistCategories(db: Db) {
  return db
    .select({ slug: t.categories.slug })
    .from(t.categories)
    .where(visiblePlaylist)
    .orderBy(t.categories.position, t.categories.slug);
}

// The playlist categories with the most answered rounds, across all players.
function mostPlayed(db: Db) {
  return db
    .select({ slug: ro.category })
    .from(ro)
    .innerJoin(t.categories, eq(t.categories.slug, ro.category))
    .where(visiblePlaylist)
    .groupBy(ro.category)
    .orderBy(desc(count()), ro.category)
    .limit(fallbackCategories);
}

// The tracks the player answered, ever or after `since`.
function answered(db: Db, playerKey: string, since?: number) {
  return db
    .select({ trackKey: ro.trackKey })
    .from(ro)
    .where(
      and(
        eq(ro.playerKey, playerKey),
        since === undefined ? undefined : gt(ro.answeredAt, since),
      ),
    );
}

// Correct rate rewards the cells the player actually knows; answer speed does
// the same, scaled so a slow average still counts something.
function mergeCells(
  outcomes: OutcomeCellRow[],
  listening: ListeningCellRow[],
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
async function knownCandidates(
  db: Db,
  playerKey: string,
  cells: Cell[],
  since: number,
) {
  if (cells.length === 0) return [];
  const inCells = or(
    ...cells.map((cell) =>
      cell.era === null
        ? eq(cs.category, cell.category)
        : and(eq(cs.category, cell.category), eq(rowDecade(), cell.era)),
    ),
  );
  const rows = await db
    .select({ ...poolFields(), decade: rowDecade(), category: cs.category })
    .from(cs)
    .innerJoin(cm, eq(cm.sourceId, cs.id))
    .innerJoin(ct, eq(ct.trackKey, cm.trackKey))
    .innerJoin(
      t.categories,
      and(eq(t.categories.slug, cs.category), eq(t.categories.hidden, 0)),
    )
    .where(
      and(
        isNull(ct.bannedAt),
        notInArray(ct.trackKey, answered(db, playerKey, since)),
        inCells,
      ),
    )
    .orderBy(cs.position, cs.id, cm.position)
    .limit(80);
  return dedupePool(rows);
}

// New tracks share a source playlist with tracks the player answered
// correctly, and are ranked by how many of those tracks they sit beside.
async function newCandidates(db: Db, playerKey: string) {
  const seed = alias(t.catalogMembers, "seed");
  const shared = countDistinct(ro.trackKey);
  const rows = await db
    .select({
      ...poolFields(),
      decade: groupDecade(),
      category: min(cs.category),
      shared,
    })
    .from(ro)
    .innerJoin(seed, eq(seed.trackKey, ro.trackKey))
    .innerJoin(cm, eq(cm.sourceId, seed.sourceId))
    .innerJoin(ct, eq(ct.trackKey, cm.trackKey))
    .innerJoin(cs, eq(cs.id, cm.sourceId))
    .innerJoin(
      t.categories,
      and(eq(t.categories.slug, cs.category), eq(t.categories.hidden, 0)),
    )
    .where(
      and(
        eq(ro.playerKey, playerKey),
        eq(ro.correct, 1),
        isNull(ct.bannedAt),
        notInArray(ct.trackKey, answered(db, playerKey)),
      ),
    )
    .groupBy(ct.trackKey)
    .orderBy(desc(shared), min(cs.position), min(cs.id), min(cm.position))
    .limit(40);
  return dedupePool(rows);
}

// The pool the mix falls back to: the union of the most-played categories'
// catalogs, all eras, topped up with the first playlist categories by
// position when fewer have been played.
async function fallbackPool(
  db: Db,
  playerKey: string,
  since: number,
  played: string[],
  playlists: string[],
) {
  const slugs = [...played];
  for (const slug of playlists) {
    if (slugs.length >= fallbackCategories) break;
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  if (slugs.length === 0) return [];
  const rows = await db
    .select({
      ...poolFields(),
      decade: groupDecade(),
      category: min(cs.category),
    })
    .from(cs)
    .innerJoin(cm, eq(cm.sourceId, cs.id))
    .innerJoin(ct, eq(ct.trackKey, cm.trackKey))
    .where(
      and(
        inArray(cs.category, slugs),
        isNull(ct.bannedAt),
        notInArray(ct.trackKey, answered(db, playerKey, since)),
      ),
    )
    .groupBy(ct.trackKey)
    .orderBy(min(cs.position), min(cs.id), min(cm.position));
  return dedupePool(rows);
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
async function revalidate(db: Db, cached: Candidate[]) {
  const keys = [...new Set(cached.map(trackKeyFor))].filter(
    (key) => !key.startsWith("at:"),
  );
  if (keys.length === 0) return null;
  const rows: PoolRow[] = await db
    .select({ ...poolFields(), decade: rowDecade(), category: cs.category })
    .from(ct)
    .innerJoin(cm, eq(cm.trackKey, ct.trackKey))
    .innerJoin(cs, eq(cs.id, cm.sourceId))
    .innerJoin(
      t.categories,
      and(eq(t.categories.slug, cs.category), eq(t.categories.hidden, 0)),
    )
    .where(and(isNull(ct.bannedAt), inArray(ct.trackKey, keys)));
  const live = new Map<string, PoolRow>();
  for (const row of rows) live.set(`${row.trackKey}:${row.category}`, row);
  const seen = new Set<string>();
  const tracks: Candidate[] = [];
  for (const track of cached) {
    const row = live.get(`${trackKeyFor(track)}:${track.category}`);
    if (row === undefined) continue;
    const key = answerKey(row.title);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      ...track,
      title: row.title,
      original: row.originalTitle ?? undefined,
      work: workLabel(row.work, row.theme),
      artist: row.artist,
      cover: row.cover,
      link: row.link,
      preview: row.preview ?? undefined,
      year: row.year ?? undefined,
      decade: row.decade ?? undefined,
    });
  }
  return distinctAnswers(tracks) >= roundsPerGame ? tracks : null;
}

export async function forYouCold(
  db: Db,
  playerKey: string,
  userId: number | null,
) {
  const [played, listening] = await Promise.all([
    db.$count(ro, eq(ro.playerKey, playerKey)),
    userId === null ? [] : listeningCells(db, userId),
  ]);
  if (played >= coldRounds) return false;
  return userId === null || listening.length === 0;
}

export async function forYouMix(
  env: Env,
  playerKey: string,
  userId: number | null,
  mode: Mode,
  rand?: () => number,
): Promise<Candidate[]> {
  const db = database(env.DB);
  const key = `play:foryou:${playerKey}:${mode}`;
  const cached = await env.CACHE.get<Candidate[]>(key, "json").catch(
    () => null,
  );
  if (cached && cached.length > 0) {
    const live = await revalidate(db, cached);
    if (live !== null) return live;
  }
  const since = Math.floor(Date.now() / 1000) - recentSeconds;
  // Two rounds of queries: everything that needs no other result, then the
  // pools that need the cells and the fallback categories.
  const [outcomes, listening, playlists, played, newPool] = await Promise.all([
    outcomeCells(db, playerKey),
    userId === null ? [] : listeningCells(db, userId),
    playlistCategories(db).then((rows) => rows.map((row) => row.slug)),
    mostPlayed(db).then((rows) => rows.map((row) => row.slug)),
    newCandidates(db, playerKey),
  ]);
  const rounds = outcomes.reduce((total, row) => total + row.played, 0);
  const cold = rounds < coldRounds && listening.length === 0;
  const [fallback, knownPool] = await Promise.all([
    fallbackPool(db, playerKey, since, played, playlists),
    cold
      ? []
      : knownCandidates(
          db,
          playerKey,
          mergeCells(outcomes, listening, playlists),
          since,
        ),
  ]);
  // The draw favours tracks the player's predicted chance puts nearest the
  // target: likely to know, not certain.
  const pools = [knownPool, newPool, fallback].filter(
    (pool) => pool.length > 0,
  );
  const items = pools.flat().map((track) => ({
    key: trackKeyFor(track),
    category: track.category ?? forYouSlug,
  }));
  const weights = await drawWeights(db, [playerKey], items, mode);
  const weightOf = new Map(
    items.map((item, index) => [item.key, weights[index]]),
  );
  const draw = (pool: Candidate[]) =>
    weightedShuffle(
      pool,
      (track) => weightOf.get(trackKeyFor(track)) ?? 1,
      rand,
    );
  const seen = new Set<string>();
  let tracks: Candidate[];
  if (cold) {
    tracks = takeDistinct([draw(fallback)], roundsPerGame + spare, seen);
  } else {
    const known = takeDistinct(
      [draw(knownPool), draw(fallback)],
      knownTarget,
      seen,
    );
    const fresh = takeDistinct(
      [draw(newPool), draw(knownPool), draw(fallback)],
      newTarget,
      seen,
    );
    const extra = takeDistinct(
      [draw(knownPool), draw(newPool), draw(fallback)],
      spare,
      seen,
    );
    tracks = interleave([known, fresh, extra]);
  }
  if (tracks.length > 0)
    await env.CACHE.put(key, JSON.stringify(tracks), {
      expirationTtl: mixTtlSeconds,
    }).catch(() => undefined);
  return tracks;
}
