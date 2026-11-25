import { eq, max } from "drizzle-orm";
import { database, t } from "../../platform/db";
import type { Env } from "../../env";
import { forgetHubTiles } from "../hub/hub";
import { forgetCategory } from "./cache";
import { dropTrackCaches } from "./refresh";

// The admin's catalog writes. Each one forgets the cached copies it changes.

// Returns false when the slug is taken.
export async function createCategory(env: Env, slug: string, name: string) {
  const db = database(env.DB);
  const last = await db
    .select({ position: max(t.categories.position) })
    .from(t.categories)
    .get();
  try {
    await db.insert(t.categories).values({
      slug,
      name,
      feed: "deezer_playlist",
      position: (last?.position ?? 0) + 10,
    });
  } catch {
    return false;
  }
  await forgetHubTiles(env);
  return true;
}

export async function saveCategory(
  env: Env,
  slug: string,
  fields: { name: string; position: number; hidden: number },
) {
  await database(env.DB)
    .update(t.categories)
    .set(fields)
    .where(eq(t.categories.slug, slug));
  await Promise.all([forgetCategory(env, slug), forgetHubTiles(env)]);
}

export interface NewSource {
  ref: string;
  title: string | null;
  tracksCount: number | null;
  decade: number | null;
}

// A new source holds no members until its first refresh, so the cached list
// is still right. Returns false when the category already lists the source.
export async function addSource(env: Env, category: string, source: NewSource) {
  const db = database(env.DB);
  const last = await db
    .select({ position: max(t.categorySources.position) })
    .from(t.categorySources)
    .where(eq(t.categorySources.category, category))
    .get();
  try {
    await db.insert(t.categorySources).values({
      category,
      kind: "deezer_playlist",
      ...source,
      position: (last?.position ?? -1) + 1,
    });
  } catch {
    return false;
  }
  return true;
}

export async function removeSource(env: Env, category: string, id: number) {
  await database(env.DB)
    .delete(t.categorySources)
    .where(eq(t.categorySources.id, id));
  await forgetCategory(env, category);
}

export async function saveTrackAnswer(
  env: Env,
  trackKey: string,
  answer: { title: string | null; year: number | null },
) {
  await database(env.DB)
    .update(t.catalogTracks)
    .set({ answerTitle: answer.title, answerYear: answer.year })
    .where(eq(t.catalogTracks.trackKey, trackKey));
  await dropTrackCaches(env, trackKey);
}

// A null ban lifts it.
export async function setTrackBan(
  env: Env,
  trackKey: string,
  ban: { reason: string | null } | null,
) {
  await database(env.DB)
    .update(t.catalogTracks)
    .set({
      bannedAt: ban === null ? null : Math.floor(Date.now() / 1000),
      banReason: ban?.reason ?? null,
    })
    .where(eq(t.catalogTracks.trackKey, trackKey));
  await dropTrackCaches(env, trackKey);
}
