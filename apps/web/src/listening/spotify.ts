import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import * as v from "valibot";
import { eq, sql } from "drizzle-orm";
import { base64url, cookieClear, sessionUser } from "../account/auth";
import { database, t, type Db, type SourceRow } from "../platform/db";
import { markDuplicates } from "./duplicates";
import { storeListens } from "./matching";
import { openSecret, sealSecret } from "../platform/secret";
import { idlePullDelay } from "./pull";
import type { Env } from "../env";

const accountsBase = "https://accounts.spotify.com";
const apiBase = "https://api.spotify.com";
const scope = "user-read-recently-played";
const stateSeconds = 600;

// The endpoint holds only the last 50 plays, so a source never idles longer
// than an hour; a pull that stored plays checks again sooner.
const playsFoundDelay = 20 * 60;
const idleCap = 60 * 60;

// Refresh a few minutes early so a token never expires mid-pull.
const expiryMargin = 300;

const cookieBase = {
  prefix: "host",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

const TrackSchema = v.object({
  id: v.string(),
  name: v.string(),
  type: v.optional(v.string()),
  artists: v.array(v.object({ name: v.string() })),
  external_ids: v.optional(v.object({ isrc: v.optional(v.string()) })),
});

const PlaySchema = v.object({
  played_at: v.string(),
  track: TrackSchema,
});

export const RecentlyPlayedSchema = v.object({
  items: v.array(PlaySchema),
});

export type RecentlyPlayed = v.InferOutput<typeof PlaySchema>;

export type SpotifyFetcher = typeof fetch;

interface StoredTokens {
  r: string;
  a?: string;
  e?: number;
}

export async function sealTokens(env: Env, tokens: StoredTokens) {
  return sealSecret(env, JSON.stringify(tokens));
}

export async function openTokens(env: Env, secret: ArrayBuffer | Uint8Array) {
  return JSON.parse(await openSecret(env, secret)) as StoredTokens;
}

function credentials(context: Context<{ Bindings: Env }>) {
  const id = context.env.SPOTIFY_CLIENT_ID;
  const secret = context.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret)
    return context.text("Spotify sign-in is not configured", 503);
  return { id, secret };
}

export async function beginSpotify(context: Context<{ Bindings: Env }>) {
  if ((await sessionUser(context)) === null) return context.redirect("/", 303);
  const keys = credentials(context);
  if (keys instanceof Response) return keys;
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const target = new URL(`${accountsBase}/authorize`);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", keys.id);
  target.searchParams.set(
    "redirect_uri",
    `${new URL(context.req.url).origin}/auth/spotify/callback`,
  );
  target.searchParams.set("scope", scope);
  target.searchParams.set("state", state);
  setCookie(context, "spotify-state", state, {
    ...cookieBase,
    maxAge: stateSeconds,
  });
  return context.redirect(target.toString(), 302);
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

async function tokenRequest(
  env: Env,
  body: URLSearchParams,
  fetcher: SpotifyFetcher,
) {
  const keys = `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`;
  const response = await fetcher(`${accountsBase}/api/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(keys)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  return {
    status: response.status,
    body: (await response.json()) as TokenResponse,
  };
}

export async function spotifyCallback(
  context: Context<{ Bindings: Env }>,
  fetcher: SpotifyFetcher = fetch,
) {
  const user = await sessionUser(context);
  if (user === null) return context.redirect("/", 303);
  const keys = credentials(context);
  if (keys instanceof Response) return keys;
  const code = context.req.query("code");
  const state = context.req.query("state");
  const expected = getCookie(context, "spotify-state", "host");
  deleteCookie(context, "spotify-state", cookieClear);
  if (!code || !state || expected === undefined || state !== expected)
    return context.text("The sign-in state does not match. Start again.", 400);

  const origin = new URL(context.req.url).origin;
  // Spotify's error bodies carry no token, so they are safe to log; the
  // reason only reaches the Worker log, never the page.
  const failed = (
    step: string,
    status: number,
    detail?: unknown,
    message = "Spotify sign-in failed. Start again.",
  ) => {
    console.error("spotify callback failed", { step, status, detail });
    return context.text(message, status === 403 ? 403 : 502);
  };
  const exchange = await tokenRequest(
    context.env,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/auth/spotify/callback`,
    }),
    fetcher,
  );
  if (exchange.status !== 200 || typeof exchange.body.access_token !== "string")
    return failed("token", exchange.status, exchange.body.error);
  const token = exchange.body;

  const me = await fetcher(`${apiBase}/v1/me`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  // A development-mode app answers 403 for any account the owner has not
  // added under User Management in the Spotify dashboard.
  if (me.status === 403)
    return failed(
      "me",
      403,
      await me.text(),
      "This Spotify account is not on Earshot's allowed list yet. Ask the site owner to add it, then connect again.",
    );
  if (!me.ok) return failed("me", me.status, await me.text());
  const profile = (await me.json()) as { id?: string };
  if (typeof profile.id !== "string") return failed("me", me.status, "no id");

  const now = Math.floor(Date.now() / 1000);
  const secret = await sealTokens(context.env, {
    r: token.refresh_token ?? "",
    a: token.access_token,
    e: now + (token.expires_in ?? 3600),
  });
  if (secret === undefined) return failed("seal", 0);
  await database(context.env.DB)
    .insert(t.sources)
    .values({
      userId: user.id,
      kind: "spotify",
      account: profile.id,
      secret,
      nextPullAt: now,
    })
    .onConflictDoUpdate({
      target: [t.sources.userId, t.sources.kind],
      set: {
        account: profile.id,
        secret,
        nextPullAt: now,
        status: "active",
        error: null,
        idlePulls: 0,
      },
    });
  return context.redirect("/settings", 303);
}

interface SpotifyPlay {
  at: number;
  track: RecentlyPlayed["track"];
}

function retryAfterSeconds(response: Response) {
  const raw = response.headers.get("retry-after");
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 60;
}

async function refreshedTokens(
  env: Env,
  db: Db,
  source: SourceRow,
  tokens: StoredTokens,
  now: number,
  fetcher: SpotifyFetcher,
) {
  if (tokens.a && tokens.e && tokens.e > now + expiryMargin) return tokens;
  const response = await tokenRequest(
    env,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.r,
    }),
    fetcher,
  );
  if (response.body.error === "invalid_grant") {
    await db
      .update(t.sources)
      .set({
        status: "error",
        nextPullAt: null,
        error:
          "Spotify access was revoked. Remove the source and connect Spotify again.",
      })
      .where(eq(t.sources.id, source.id));
    return null;
  }
  if (response.status !== 200 || typeof response.body.access_token !== "string")
    throw new Error(`Spotify token refresh returned ${response.status}`);
  const next: StoredTokens = {
    r: response.body.refresh_token ?? tokens.r,
    a: response.body.access_token,
    e: now + (response.body.expires_in ?? 3600),
  };
  if (next.r !== tokens.r || next.a !== tokens.a) {
    await db
      .update(t.sources)
      .set({ secret: await sealTokens(env, next) })
      .where(eq(t.sources.id, source.id));
  }
  return next;
}

export function playInputs(
  plays: SpotifyPlay[],
  userId: number,
  sourceId: number,
) {
  return plays.map((play) => ({
    kind: "spotify",
    sourceKey: play.track.id,
    artist: play.track.artists[0]?.name ?? "",
    title: play.track.name,
    isrc: play.track.external_ids?.isrc,
    listenedAt: play.at,
    userId,
    sourceId,
  }));
}

export async function pullSpotify(
  env: Env,
  source: SourceRow,
  fetcher: SpotifyFetcher = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  if (!source.secret)
    throw new Error("Spotify source has no token; reconnect it in settings");
  const db = database(env.DB);
  const stored = await openTokens(env, source.secret);
  const tokens = await refreshedTokens(env, db, source, stored, now, fetcher);
  if (tokens === null) return { inserted: 0, cursor: source.cursor };

  const url = new URL(`${apiBase}/v1/me/player/recently-played`);
  url.searchParams.set("limit", "50");
  if (source.cursor !== null)
    url.searchParams.set("after", String(source.cursor * 1000));
  const response = await fetcher(url.toString(), {
    headers: { authorization: `Bearer ${tokens.a}` },
  });
  if (response.status === 429) {
    await db
      .update(t.sources)
      .set({ nextPullAt: now + retryAfterSeconds(response) })
      .where(eq(t.sources.id, source.id));
    return { inserted: 0, cursor: source.cursor };
  }
  if (!response.ok) throw new Error(`Spotify returned ${response.status}`);
  const parsed = v.safeParse(RecentlyPlayedSchema, await response.json());
  if (!parsed.success) throw new Error("Spotify returned an invalid response");

  const plays: SpotifyPlay[] = [];
  for (const item of parsed.output.items) {
    if (item.track.type === "episode") continue;
    const at = Date.parse(item.played_at);
    if (Number.isNaN(at)) continue;
    plays.push({ at: Math.floor(at / 1000), track: item.track });
  }

  const inserted = await storeListens(
    db,
    playInputs(plays, source.userId, source.id),
    "spotify",
  );
  if (plays.length > 0)
    await markDuplicates(
      db,
      source.userId,
      Math.min(...plays.map((play) => play.at)),
      Math.max(...plays.map((play) => play.at)),
    );

  const cursor =
    plays.length === 0
      ? source.cursor
      : Math.max(source.cursor ?? 0, ...plays.map((play) => play.at));
  const idlePulls = inserted > 0 ? 0 : source.idlePulls + 1;
  const delay =
    inserted > 0
      ? playsFoundDelay
      : Math.min(idleCap, idlePullDelay(idlePulls));
  await db
    .update(t.sources)
    .set({
      cursor,
      idlePulls,
      nextPullAt: now + delay,
      status: "active",
      error: null,
      lastOkAt: now,
      playCount: sql`${t.sources.playCount} + ${inserted}`,
    })
    .where(eq(t.sources.id, source.id));
  return { inserted, cursor };
}
