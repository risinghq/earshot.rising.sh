import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { base64url } from "../auth";
import { normalizeText } from "../normalize";
import type { Env } from "../types";
import { trackDecade } from "./pool";
import type { Mode } from "./quiz";
import type { GameKind } from "./results";
import type { Candidate } from "./sources";

const anonSeconds = 365 * 86400;
const anonCookie = "play-id";

const anonBase = {
  prefix: "host",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

// The player key is the user id while signed in and a browser cookie
// otherwise, so one person's answers stay together across both states.
export function playerKeyOf(userId: number | null, anon: string | null) {
  return userId !== null ? `u:${userId}` : `a:${anon ?? ""}`;
}

export function anonOf(context: Context<{ Bindings: Env }>) {
  return getCookie(context, anonCookie, "host") ?? null;
}

// Mints the anonymous id when a game starts for a signed-out player; the
// cookie is httpOnly so the value never reaches a script.
export function anonKey(
  context: Context<{ Bindings: Env }>,
  mint = true,
): string | null {
  const existing = anonOf(context);
  if (existing !== null || !mint) return existing;
  const value = base64url(crypto.getRandomValues(new Uint8Array(16)));
  setCookie(context, anonCookie, value, {
    ...anonBase,
    maxAge: anonSeconds,
  });
  return value;
}

export function trackKeyFor(track: {
  title: string;
  artist: string;
  deezerId?: number;
  itunesId?: number;
}) {
  if (track.deezerId !== undefined) return `dz:${track.deezerId}`;
  if (track.itunesId !== undefined) return `it:${track.itunesId}`;
  return `at:${normalizeText(track.artist)}/${normalizeText(track.title)}`;
}

export interface Outcome {
  playerKey: string;
  userId: number | null;
  track: Candidate;
  category: string;
  mode: Mode;
  kind: GameKind;
  correct: boolean;
  elapsedMs: number;
}

export async function recordOutcomes(
  env: Env,
  rows: Outcome[],
  now = Math.floor(Date.now() / 1000),
) {
  if (rows.length === 0) return;
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO round_outcomes
           (player_key, user_id, track_key, category, era, mode, kind,
            correct, elapsed_ms, answered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(
        row.playerKey,
        row.userId,
        trackKeyFor(row.track),
        row.category,
        trackDecade(row.track),
        row.mode,
        row.kind,
        row.correct ? 1 : 0,
        row.elapsedMs,
        now,
      ),
    ),
  );
}

// Answers an anonymous browser left behind belong to the account once it
// signs in; the cookie stays, so later guest games merge on the next sign-in.
export async function mergeAnonOutcomes(
  db: D1Database,
  anon: string,
  userId: number,
) {
  await db
    .prepare(
      "UPDATE round_outcomes SET player_key = ?1, user_id = ?2 WHERE player_key = ?3",
    )
    .bind(`u:${userId}`, userId, `a:${anon}`)
    .run();
}
