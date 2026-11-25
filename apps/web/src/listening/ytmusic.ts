import { and, eq, sql } from "drizzle-orm";
import { database, t, type Db, type SourceRow } from "../platform/db";
import { ingestPage, pageSourceFields, type PagePlay } from "./ingest";
import { openSecret, sealSecret } from "../platform/secret";
import type { Env } from "../env";
import {
  fetchHistoryPage,
  hasSapisid,
  HistoryPageError,
  parseHistoryPage,
  SignedOutError,
  todayIn,
  type YouTubeFetcher,
} from "./youtube";

// The page holds about 200 plays, roughly ten hours of continuous listening,
// so an hourly pull keeps a tenfold margin for 24 fetches a day.
export const pullIntervalSeconds = 3600;

const signedOutMessage = "YouTube signed you out. Paste a new cookie.";
const parseMessage =
  "The YouTube Music history page did not parse. Paste a new cookie.";

function toPagePlays(plays: ReturnType<typeof parseHistoryPage>) {
  const accepted: PagePlay[] = [];
  for (const play of plays) {
    if (play.day === null || play.videoId === null) continue;
    if ([...play.title].length > 512 || [...play.artist].length > 512) continue;
    accepted.push({
      day: play.day,
      artist: play.artist,
      title: play.title,
      video_id: play.videoId,
    });
  }
  return accepted;
}

async function stopPulls(db: Db, sourceId: number, error: string) {
  await db
    .update(t.sources)
    .set({ status: "error", error, nextPullAt: null })
    .where(eq(t.sources.id, sourceId));
}

export async function pullYouTube(
  env: Env,
  source: SourceRow,
  fetcher: YouTubeFetcher = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  const db = database(env.DB);
  if (!source.secret) {
    await stopPulls(db, source.id, signedOutMessage);
    return { inserted: 0 };
  }
  const cookie = await openSecret(env, source.secret);
  const html = await fetchHistoryPage(cookie, fetcher, now);

  const today = todayIn(now, source.tz ?? "UTC");
  let plays;
  try {
    plays = parseHistoryPage(html, today);
  } catch (error) {
    if (error instanceof SignedOutError) {
      await stopPulls(db, source.id, signedOutMessage);
      return { inserted: 0 };
    }
    if (error instanceof HistoryPageError) {
      await stopPulls(db, source.id, parseMessage);
      return { inserted: 0 };
    }
    throw error;
  }

  const result = await ingestPage(db, source, toPagePlays(plays), {
    now,
    pullNextAt: now + pullIntervalSeconds,
  });
  return { inserted: result.inserted };
}

const ytmusicOf = (userId: number) =>
  and(eq(t.sources.userId, userId), eq(t.sources.kind, "ytmusic"));

// A connect attempt the user can fix: the message and the form field it
// points at.
export interface ConnectProblem {
  error: string;
  field: "cookie" | "tz";
}

// Reads the history page once before storing the cookie, so a cookie that
// cannot sign in is refused at the form instead of failing the first pull.
export async function connectYouTube(
  env: Env,
  userId: number,
  cookie: string,
  tzInput: string,
): Promise<{ inserted: number } | ConnectProblem> {
  let tz: string;
  try {
    tz = new Intl.DateTimeFormat("en-US", {
      timeZone: tzInput,
    }).resolvedOptions().timeZone;
  } catch {
    return {
      error:
        "The time zone is not a known IANA name, for example Europe/Berlin.",
      field: "tz",
    };
  }
  if (!hasSapisid(cookie))
    return {
      error:
        "The cookie has no __Secure-3PAPISID. Copy the whole Cookie request header, not one cookie.",
      field: "cookie",
    };

  let html: string;
  try {
    html = await fetchHistoryPage(cookie);
  } catch {
    return {
      error: "YouTube Music could not be reached. Try again in a moment.",
      field: "cookie",
    };
  }
  const now = Math.floor(Date.now() / 1000);
  let plays;
  try {
    plays = parseHistoryPage(html, todayIn(now, tz));
  } catch (error) {
    if (error instanceof SignedOutError)
      return {
        error:
          "YouTube Music answered as signed out. Copy the cookie from a signed-in browser session.",
        field: "cookie",
      };
    if (error instanceof HistoryPageError)
      return {
        error: "The YouTube Music history page did not parse.",
        field: "cookie",
      };
    throw error;
  }

  const db = database(env.DB);
  const secret = await sealSecret(env, cookie);
  const [, [source]] = await db.batch([
    db
      .insert(t.sources)
      .values({
        userId,
        kind: "ytmusic",
        secret,
        tz,
        nextPullAt: now + pullIntervalSeconds,
      })
      .onConflictDoUpdate({
        target: [t.sources.userId, t.sources.kind],
        set: {
          secret: sql`excluded.secret`,
          tz: sql`excluded.tz`,
          nextPullAt: sql`excluded.next_pull_at`,
          error: null,
        },
      }),
    db.select(pageSourceFields).from(t.sources).where(ytmusicOf(userId)),
  ]);
  if (source === undefined) return { inserted: 0 };
  const result = await ingestPage(db, source, toPagePlays(plays), {
    now,
    pullNextAt: now + pullIntervalSeconds,
  });
  return { inserted: result.inserted };
}

// Forgets the cookie and stops the pulls; the source and its plays stay.
export async function disconnectYouTube(env: Env, userId: number) {
  await database(env.DB)
    .update(t.sources)
    .set({
      secret: null,
      nextPullAt: null,
      error: null,
      status: sql`CASE WHEN ${t.sources.status} = 'error' THEN 'active' ELSE ${t.sources.status} END`,
    })
    .where(ytmusicOf(userId));
}
