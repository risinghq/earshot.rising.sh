import type { Env } from "../types";
import { answerKey } from "./quiz";
import { FeedError } from "./http";
import {
  appleChart,
  deezerArtist,
  deezerArtistTop,
  deezerChart,
  deezerPlaylist,
  type Candidate,
} from "./sources";

export interface Category {
  slug: string;
  name: string;
  feed:
    | "deezer_chart"
    | "deezer_playlist"
    | "deezer_artist"
    | "apple_chart"
    | "mine";
  ref: string | null;
}

const catalogTtlSeconds = 6 * 3600;
const artistNameTtlSeconds = 24 * 3600;

// An artist category is not a row: `artist-123` is one Deezer artist and
// `artist-123-456` is two, so the slug alone decides the shape.
export function parseArtistSlug(slug: string): number[] | null {
  const match = /^artist-(\d{1,10})(?:-(\d{1,10}))?$/.exec(slug);
  if (match === null) return null;
  const ids = match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map((part) => Number(part));
  return ids[1] === ids[0] ? [ids[0]] : ids;
}

export function listCategories(db: D1Database) {
  return db
    .prepare("SELECT slug, name, feed, ref FROM categories ORDER BY rowid")
    .all<Category>()
    .then((result) => result.results);
}

// A null is a definite unknown id: Deezer answered the artist endpoint with
// its error body, so the category does not exist. A failed lookup is less
// sure, so it falls back to a bare name and the track feed decides, keeping
// a flaky /artist answer on the category-unavailable page.
async function artistName(env: Env, id: number): Promise<string | null> {
  const key = `play:artist:${id}`;
  const cached = await env.CACHE?.get<{ name: string }>(key, "json").catch(
    () => null,
  );
  if (cached?.name) return cached.name;
  try {
    const artist = await deezerArtist(id);
    if (artist === null) return null;
    if (env.CACHE)
      await env.CACHE.put(key, JSON.stringify({ name: artist.name }), {
        expirationTtl: artistNameTtlSeconds,
      }).catch(() => undefined);
    return artist.name;
  } catch {
    return `Artist ${id}`;
  }
}

async function artistCategory(
  env: Env,
  ids: number[],
): Promise<Category | null> {
  const names = await Promise.all(ids.map((id) => artistName(env, id)));
  if (names.includes(null)) return null;
  return {
    slug: `artist-${ids.join("-")}`,
    name: names.join(" × "),
    feed: "deezer_artist",
    ref: ids.join(","),
  };
}

export async function getCategory(env: Env, slug: string) {
  const ids = parseArtistSlug(slug);
  if (ids !== null) return artistCategory(env, ids);
  if (slug.startsWith("artist-")) return null;
  return env.DB.prepare(
    "SELECT slug, name, feed, ref FROM categories WHERE slug = ?1",
  )
    .bind(slug)
    .first<Category>();
}

export { FeedError };

async function userCatalog(db: D1Database, userId: number) {
  const result = await db
    .prepare(
      `SELECT tracks.title, artists.name AS artist, tracks.isrc
       FROM track_totals
       JOIN tracks ON tracks.id = track_totals.track_id
       JOIN artists ON artists.id = tracks.artist_id
       WHERE track_totals.user_id = ?1
       ORDER BY track_totals.plays DESC
       LIMIT 40`,
    )
    .bind(userId)
    .all<{ title: string; artist: string; isrc: string | null }>();
  return result.results.map((row) => ({
    title: row.title,
    artist: row.artist,
    cover: null,
    link: null,
    isrc: row.isrc ?? undefined,
  }));
}

// A blended category alternates the artists' top tracks; when the shorter
// list runs out, the rest of the longer one follows.
export function interleave(lists: Candidate[][]) {
  const tracks: Candidate[] = [];
  for (let index = 0; ; index += 1) {
    let more = false;
    for (const list of lists) {
      if (index < list.length) {
        tracks.push(list[index]);
        more = true;
      }
    }
    if (!more) return tracks;
  }
}

// A game needs at least four different answers so the choices mode can offer
// four buttons; titles that only differ in a suffix count once. Artist feeds
// are rejected below that line; the curated feeds keep the raw-count check
// they always had.
export function distinctAnswers(tracks: Candidate[]) {
  return new Set(
    tracks.map((track) => answerKey(track.title)).filter((key) => key !== ""),
  ).size;
}

export function enoughTracks(category: Category, tracks: Candidate[]) {
  return category.feed === "deezer_artist"
    ? distinctAnswers(tracks) >= 4
    : tracks.length >= 4;
}

export async function catalog(
  env: Env,
  category: Category,
  userId: number | null,
): Promise<Candidate[]> {
  if (category.feed === "mine") {
    if (userId === null) throw new FeedError("sign-in required", category.slug);
    return userCatalog(env.DB, userId);
  }
  const key = `play:cat:${category.slug}`;
  const cached = await env.CACHE?.get<Candidate[]>(key, "json").catch(
    () => null,
  );
  if (cached && cached.length > 0) return cached;
  let tracks: Candidate[];
  if (category.feed === "deezer_chart")
    tracks = await deezerChart(category.ref ?? "0");
  else if (category.feed === "deezer_playlist")
    tracks = await deezerPlaylist(category.ref ?? "0");
  else if (category.feed === "deezer_artist") {
    const lists = await Promise.all(
      (category.ref ?? "").split(",").map((id) => deezerArtistTop(Number(id))),
    );
    // An empty top list means the id is unknown or has no tracks; playing on
    // would quietly turn a blend into a solo game.
    if (lists.some((list) => list.length === 0))
      throw new FeedError("artist has no top tracks", category.slug);
    tracks = interleave(lists);
  } else tracks = await appleChart(category.ref ?? "us");
  if (env.CACHE && tracks.length > 0)
    await env.CACHE.put(key, JSON.stringify(tracks), {
      expirationTtl: catalogTtlSeconds,
    }).catch(() => undefined);
  return tracks;
}
