import type { Env } from "../../env";
import type { Candidate } from "./sources";

// The KV copy of a category's track list. A write to the category, its
// sources or its tracks must forget it, or games keep the old list until the
// TTL runs out.
export const categoryKey = (slug: string) => `play:cat:${slug}`;

export const readCachedCategory = (env: Env, slug: string) =>
  env.CACHE.get<Candidate[]>(categoryKey(slug), "json").catch(() => null);

export const forgetCategory = (env: Env, slug: string) =>
  env.CACHE.delete(categoryKey(slug)).catch(() => undefined);
