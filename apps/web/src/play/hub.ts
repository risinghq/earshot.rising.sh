import type { Env } from "../types";
import { catalog, type Category } from "./catalog";
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
async function factsOf(env: Env, category: Category): Promise<TileFacts> {
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
  } catch {
    // A tile without covers or eras still starts a game.
  }
  return { eras: [], covers: [] };
}

export async function tileFacts(env: Env, categories: Category[]) {
  return Object.fromEntries(
    await Promise.all(
      categories.map(async (category): Promise<[string, TileFacts]> => [
        category.slug,
        await factsOf(env, category),
      ]),
    ),
  );
}
