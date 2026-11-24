import { eq, lte, sql } from "drizzle-orm";
import { database, t, type SourceRow } from "../platform/db";
import {
  failureMessage,
  isDailyLimit,
  maxSourcesPerPull,
  nextPullDelay,
  nextUtcMidnight,
} from "./pull";
import { pullSpotify } from "./spotify";
import { pullYouTube } from "./ytmusic";
import type { Env } from "../env";

const d1CapKey = "d1-capped";

const pulls: Record<
  string,
  (env: Env, source: SourceRow, now: number) => Promise<unknown>
> = {
  spotify: (env, source, now) => pullSpotify(env, source, undefined, now),
  ytmusic: (env, source, now) => pullYouTube(env, source, undefined, now),
};

export async function pullDueSources(
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  if (await env.CACHE.get(d1CapKey)) return;
  const db = database(env.DB);
  let due: SourceRow[];
  try {
    due = await db
      .select()
      .from(t.sources)
      .where(lte(t.sources.nextPullAt, now))
      .orderBy(t.sources.nextPullAt, t.sources.id)
      .limit(maxSourcesPerPull);
  } catch (error) {
    if (isDailyLimit(error)) {
      await env.CACHE.put(d1CapKey, "1", {
        expiration: nextUtcMidnight(now),
      });
      return;
    }
    throw error;
  }
  for (const source of due) {
    const pull = pulls[source.kind];
    if (!pull) continue;
    try {
      await pull(env, source, now);
    } catch (error) {
      if (isDailyLimit(error)) {
        await env.CACHE.put(d1CapKey, "1", {
          expiration: nextUtcMidnight(now),
        });
        return;
      }
      await db
        .update(t.sources)
        .set({
          status: "error",
          error: failureMessage(error).slice(0, 200),
          idlePulls: sql`${t.sources.idlePulls} + 1`,
          nextPullAt: now + nextPullDelay(0, source.idlePulls + 1),
        })
        .where(eq(t.sources.id, source.id));
    }
  }
}
