import type { Env } from "../types";
import { catalogPool, songsOnce } from "./pool";
import { answerKey, roundsPerGame } from "./quiz";
import { FeedError } from "./http";
import {
  appleChart,
  deezerArtist,
  deezerArtistTop,
  deezerChart,
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
    | "mine"
    | "for_you";
  ref: string | null;
}

const catalogTtlSeconds = 6 * 3600;
const artistNameTtlSeconds = 24 * 3600;

// An artist category is not a row: `artist-123` is one Deezer artist and
// `artist-123-456` is two, so the slug alone decides the shape. A blend's ids
// sort ascending, so `artist-85-27` and `artist-27-85` are one category, one
// board and one cache entry.
export function parseArtistSlug(slug: string): number[] | null {
  const match = /^artist-(\d{1,10})(?:-(\d{1,10}))?$/.exec(slug);
  if (match === null) return null;
  const ids = match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map((part) => Number(part))
    .sort((a, b) => a - b);
  return ids[1] === ids[0] ? [ids[0]] : ids;
}

export function listCategories(db: D1Database) {
  return db
    .prepare(
      `SELECT slug, name, feed, ref FROM categories
       WHERE hidden = 0 ORDER BY position, slug`,
    )
    .all<Category>()
    .then((result) => result.results);
}

// A null is a definite unknown id: Deezer answered the artist endpoint with
// its error body, so the category does not exist. A failed lookup is less
// sure, so it falls back to a bare name and the track feed decides, keeping
// a flaky /artist answer on the category-unavailable page.
// An entry cached before the profile carried fans holds only the name, and is
// read again.
export async function artistProfile(
  env: Env,
  id: number,
): Promise<ArtistProfile | null> {
  const key = `play:artist:${id}`;
  const cached = await env.CACHE?.get<ArtistProfile>(key, "json").catch(
    () => null,
  );
  if (cached?.name && typeof cached.fans === "number") return cached;
  try {
    const artist = await deezerArtist(id);
    if (artist === null) return null;
    const profile = {
      name: artist.name,
      picture: artist.picture,
      fans: artist.fans,
    };
    if (env.CACHE)
      await env.CACHE.put(key, JSON.stringify(profile), {
        expirationTtl: artistNameTtlSeconds,
      }).catch(() => undefined);
    return profile;
  } catch {
    return { name: `Artist ${id}`, picture: null, fans: 0 };
  }
}

export interface ArtistProfile {
  name: string;
  picture: string | null;
  fans: number;
}

async function artistCategory(
  env: Env,
  ids: number[],
): Promise<Category | null> {
  const profiles = await Promise.all(ids.map((id) => artistProfile(env, id)));
  if (profiles.includes(null)) return null;
  return {
    slug: `artist-${ids.join("-")}`,
    name: profiles.map((profile) => profile!.name).join(" × "),
    feed: "deezer_artist",
    ref: ids.join(","),
  };
}

export async function getCategory(env: Env, slug: string) {
  const ids = parseArtistSlug(slug);
  if (ids !== null) return artistCategory(env, ids);
  if (slug.startsWith("artist-")) return null;
  return env.DB.prepare(
    "SELECT slug, name, feed, ref FROM categories WHERE slug = ?1 AND hidden = 0",
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

// The hub reads chart covers from the cache only, so the cron reloads one
// expired chart per run: at most one upstream request a minute, and a
// chart-fed genre shows covers whether or not anyone played it lately.
export async function warmChartCache(env: Env) {
  if (!env.CACHE) return;
  const charts = await env.DB.prepare(
    `SELECT slug, name, feed, ref FROM categories
     WHERE feed IN ('deezer_chart', 'apple_chart') AND hidden = 0
     ORDER BY position`,
  ).all<Category>();
  for (const chart of charts.results) {
    const cached = await env.CACHE.get(`play:cat:${chart.slug}`).catch(
      () => null,
    );
    if (cached !== null) continue;
    await catalog(env, chart, null).catch(() => undefined);
    return;
  }
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
// they always had. For you builds its whole game from the mix, so it needs a
// full game's worth of distinct answers, not just a round's.
export function distinctAnswers(tracks: Candidate[]) {
  return new Set(
    tracks.map((track) => answerKey(track.title)).filter((key) => key !== ""),
  ).size;
}

export function enoughTracks(category: Category, tracks: Candidate[]) {
  if (category.feed === "for_you")
    return distinctAnswers(tracks) >= roundsPerGame;
  return category.feed === "deezer_artist"
    ? distinctAnswers(tracks) >= 4
    : tracks.length >= 4;
}

export async function catalog(
  env: Env,
  category: Category,
  userId: number | null,
): Promise<Candidate[]> {
  const tracks = await feedTracks(env, category, userId);
  return category.feed === "deezer_artist" ? songsOnce(tracks) : tracks;
}

async function feedTracks(
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
    tracks = await catalogPool(env.DB, category.slug);
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
