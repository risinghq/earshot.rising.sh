import { Hono } from "hono";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { sessionUser } from "../account/auth";
import type { Env } from "../env";
import { database, t } from "../platform/db";
import { anonOf, playerKeyOf } from "./game/outcomes";

export const reportApp = new Hono<{ Bindings: Env }>();

type ReportReason = (typeof t.trackReports.reason.enumValues)[number];

const reportReasons = new Set<string>(t.trackReports.reason.enumValues);
const reportLimitPerHour = 10;

// A report needs the player key only to rate-limit it; signed-out players
// report too, so the key may be the anonymous cookie.
reportApp.post("/report", async (context) => {
  const body = await context.req.parseBody();
  const reason = typeof body.reason === "string" ? body.reason : "";
  const track = typeof body.track === "string" ? body.track : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const artist = typeof body.artist === "string" ? body.artist.trim() : "";
  const back = typeof body.back === "string" ? body.back : "/";
  if (!reportReasons.has(reason) || track === "" || title === "")
    return context.text("Bad report.", 400);
  const user = await sessionUser(context);
  // Reads the existing cookie without minting: a cookieless client lands in
  // the shared `a:` bucket so the hourly limit still applies.
  const playerKey = playerKeyOf(user?.id ?? null, anonOf(context));
  const now = Math.floor(Date.now() / 1000);
  const category = typeof body.category === "string" ? body.category : "";
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  const db = database(context.env.DB);
  // The count sits inside the insert, so two reports sent at once cannot
  // both pass a count taken before either wrote.
  const sent = await db.insert(t.trackReports).select(
    db
      .select({
        trackKey: sql<string>`${track}`.as("track_key"),
        title: sql<string>`${title}`.as("title"),
        artist: sql<string>`${artist}`.as("artist"),
        category: sql<string | null>`${category || null}`.as("category"),
        reason: sql<ReportReason>`${reason}`.as("reason"),
        detail: sql<string | null>`${detail || null}`.as("detail"),
        playerKey: sql<string>`${playerKey}`.as("player_key"),
        createdAt: sql<number>`${now}`.as("created_at"),
      })
      .from(sql`(SELECT 1)`)
      .where(
        lt(
          db.$count(
            t.trackReports,
            and(
              eq(t.trackReports.playerKey, playerKey),
              gt(t.trackReports.createdAt, now - 3600),
            ),
          ),
          reportLimitPerHour,
        ),
      ),
  );
  if (sent.meta.changes === 0)
    return context.text("Too many reports. Try again later.", 429);
  return context.redirect(
    back.startsWith("/") && !back.startsWith("//") ? back : "/",
    303,
  );
});
