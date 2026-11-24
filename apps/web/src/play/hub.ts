import { database } from "../db";
import type { Env } from "../types";
import { catalog, listCategories, type Category } from "./catalog";
import { poolEras } from "./pool";
import type { Candidate } from "./sources";

export interface TileFacts {
  eras: number[];
  covers: string[];
}

export const tileCovers = 4;

function distinctCovers(tracks: Candidate[]) {
  const covers = new Set<string>();
  for (const track of tracks) {
    if (track.cover) covers.add(track.cover);
    if (covers.size === tileCovers) break;
  }
  return [...covers];
}

// A pool category reads its pool from D1 (or the cache), which the era chips
// need anyway. A chart category would cost an outside fetch, so its tile shows
// covers only when the chart is already cached.
// A null is a pool that failed to load.
async function factsOf(
  env: Env,
  category: Category,
): Promise<TileFacts | null> {
  try {
    if (category.feed === "deezer_playlist") {
      const tracks = await catalog(env, category, null);
      return { eras: poolEras(tracks), covers: distinctCovers(tracks) };
    }
    if (category.feed === "deezer_chart" || category.feed === "apple_chart") {
      const cached = await env.CACHE?.get<Candidate[]>(
        `play:cat:${category.slug}`,
        "json",
      );
      return { eras: [], covers: distinctCovers(cached ?? []) };
    }
    return { eras: [], covers: [] };
  } catch {
    return null;
  }
}

export interface HubTiles {
  categories: Category[];
  facts: Record<string, TileFacts>;
}

export const hubTilesKey = "play:hub";
const hubTilesTtlSeconds = 600;

// The tiles' facts read every category's whole pool to keep four covers and
// a few eras, so the hub keeps the result as one small entry. A pool refresh
// reaches the tiles within the entry's lifetime; a category edit in the admin
// deletes the entry.
export async function hubTiles(env: Env): Promise<HubTiles> {
  const cached = await env.CACHE?.get<HubTiles>(hubTilesKey, "json").catch(
    () => null,
  );
  if (cached) return cached;
  const categories = await listCategories(database(env.DB));
  const facts = await Promise.all(
    categories.map((category) => factsOf(env, category)),
  );
  // A tile without covers or eras still starts a game, but a failed pool is
  // not kept for the entry's lifetime.
  const tiles: HubTiles = {
    categories,
    facts: Object.fromEntries(
      categories.map((category, i) => [
        category.slug,
        facts[i] ?? { eras: [], covers: [] },
      ]),
    ),
  };
  if (env.CACHE && !facts.includes(null))
    await env.CACHE.put(hubTilesKey, JSON.stringify(tiles), {
      expirationTtl: hubTilesTtlSeconds,
    }).catch(() => undefined);
  return tiles;
}
