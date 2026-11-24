import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { sessionUser, type SignedInUser } from "../account/auth";
import type { Env } from "../env";
import { database, t, type Db } from "../platform/db";
import { notFoundPage } from "../ui/not-found";
import { renderCard, type CardTheme } from "./card";
import { periods, profilePage, type Relation } from "./page";
import { getStats, type Period, type PeriodStats } from "./stats";

function readPeriod(value: string | undefined): Period | null {
  return value === undefined
    ? "week"
    : periods.includes(value as Period)
      ? (value as Period)
      : null;
}

function readCardSize(value: string | undefined): number | null {
  if (value === undefined) return 5;
  if (!/^(?:[1-9]|10)$/.test(value)) return null;
  return Number(value);
}

function readTheme(value: string | undefined): CardTheme | null {
  if (value === undefined) return "light";
  return value === "light" || value === "dark" ? value : null;
}

async function findUser(db: Db, name: string) {
  const u = t.users;
  return db
    .select({
      id: u.id,
      name: u.name,
      kinds: sql<string | null>`(${db
        .select({ kinds: sql`group_concat(${t.sources.kind})` })
        .from(t.sources)
        .where(eq(t.sources.userId, u.id))})`,
    })
    .from(u)
    .where(
      and(
        sql`${u.name} = ${name} COLLATE NOCASE`,
        eq(u.isPublic, 1),
        eq(u.adminHidden, 0),
      ),
    )
    .get();
}

async function getSnapshot(
  env: Env,
  user: { id: number; name: string },
  period: Period,
  now: number,
) {
  const key = `snap:${user.id}:${period}`;
  if (env.CACHE) {
    let cached: PeriodStats | null = null;
    try {
      cached = await env.CACHE.get<PeriodStats>(key, "json");
    } catch {
      cached = null;
    }
    if (
      cached &&
      cached.updated_at > now - (period === "all" ? 6 * 3600 : 15 * 60)
    )
      return cached;
  }
  const snapshot = await getStats(
    database(env.DB),
    user.id,
    user.name,
    period,
    now,
  );
  if (env.CACHE) {
    await env.CACHE.put(key, JSON.stringify(snapshot), {
      expirationTtl: period === "all" ? 6 * 3600 : 15 * 60,
    }).catch(() => undefined);
  }
  return snapshot;
}

async function relationTo(
  db: Db,
  viewer: SignedInUser | null,
  userId: number,
): Promise<Relation> {
  if (viewer === null) return "out";
  if (viewer.id === userId) return "self";
  const { friendships: f, friendRequests: r } = t;
  const [friends, sent] = await db.batch([
    db
      .select({ yes: sql`1` })
      .from(f)
      .where(and(eq(f.userId, viewer.id), eq(f.friendId, userId))),
    db
      .select({ yes: sql`1` })
      .from(r)
      .where(and(eq(r.fromUser, viewer.id), eq(r.toUser, userId))),
  ]);
  if (friends.length > 0) return "friends";
  return sent.length > 0 ? "sent" : "none";
}

export const profileApp = new Hono<{ Bindings: Env }>();

profileApp.get("/:path", async (context) => {
  const path = context.req.param("path") ?? "";
  const format = path.endsWith(".json")
    ? "json"
    : path.endsWith(".svg")
      ? "svg"
      : "html";
  const name =
    format === "json"
      ? path.slice(0, -5)
      : format === "svg"
        ? path.slice(0, -4)
        : path;
  const badRequest = (message: string) =>
    format === "json"
      ? context.json({ error: message }, 400)
      : context.text(message, 400);
  const period = readPeriod(context.req.query("period"));
  if (!period) return badRequest("period must be week, month or all");
  let card: { size: number; theme: CardTheme } | undefined;
  if (format === "svg") {
    const size = readCardSize(context.req.query("n"));
    if (size === null) return badRequest("n must be between 1 and 10");
    const theme = readTheme(context.req.query("theme"));
    if (theme === null) return badRequest("theme must be light or dark");
    card = { size, theme };
  }
  if (!name)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.html(notFoundPage(await sessionUser(context)), 404);
  // Each D1 read is a round trip to the database's region, so reads that do
  // not depend on each other run together.
  const [user, viewer] = await Promise.all([
    findUser(database(context.env.DB), name),
    format === "html" ? sessionUser(context) : null,
  ]);
  if (!user)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.html(notFoundPage(viewer), 404);
  const now = Math.floor(Date.now() / 1000);
  if (format === "html") {
    const [snapshot, relation] = await Promise.all([
      getSnapshot(context.env, user, period, now),
      relationTo(database(context.env.DB), viewer, user.id),
    ]);
    return context.html(
      profilePage(
        snapshot,
        new URL(context.req.url).origin,
        user.kinds,
        viewer,
        relation,
      ),
    );
  }
  const snapshot = await getSnapshot(context.env, user, period, now);
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Cache-Control", "public, max-age=900");
  if (card) {
    context.header("Content-Type", "image/svg+xml");
    return context.body(renderCard(snapshot, card.size, card.theme));
  }
  context.header("Access-Control-Allow-Origin", "*");
  return context.json(snapshot);
});
