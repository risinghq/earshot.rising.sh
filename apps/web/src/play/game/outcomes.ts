import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { base64url } from "../../account/auth";
import { batchWrites, database, t, type Db } from "../../platform/db";
import { normalizeText } from "../../listening/normalize";
import type { Env } from "../../env";
import { trackDecade } from "../catalog/pool";
import type { Mode } from "./quiz";
import type { GameKind } from "./results";
import type { Candidate } from "../catalog/sources";

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
  gameId: string;
  round: number;
}

export type GameOrigin = "start" | "rematch" | "pick" | "match" | "solo";

export interface GameStart {
  id: string;
  kind: GameKind;
  room: string | null;
  category: string;
  mode: Mode;
  origin: GameOrigin;
  players: number;
}

// The game log reads the room's play without asking the client for anything:
// the row is written on the server when the game begins.
export async function recordGameStart(
  env: Env,
  game: GameStart,
  now = Math.floor(Date.now() / 1000),
) {
  await database(env.DB)
    .insert(t.games)
    .values({ ...game, startedAt: now })
    .onConflictDoNothing();
}

export async function recordOutcomes(
  env: Env,
  rows: Outcome[],
  now = Math.floor(Date.now() / 1000),
) {
  const db = database(env.DB);
  // One statement per row: D1 binds at most 100 values per statement.
  await batchWrites(
    db,
    rows.map((row) =>
      db.insert(t.roundOutcomes).values({
        playerKey: row.playerKey,
        userId: row.userId,
        trackKey: trackKeyFor(row.track),
        category: row.category,
        era: trackDecade(row.track),
        mode: row.mode,
        kind: row.kind,
        correct: row.correct ? 1 : 0,
        elapsedMs: row.elapsedMs,
        answeredAt: now,
        gameId: row.gameId,
        round: row.round,
        title: row.track.title,
        artist: row.track.artist,
      }),
    ),
  );
}

// Answers an anonymous browser left behind belong to the account once it
// signs in; the cookie stays, so later guest games merge on the next sign-in.
export async function mergeAnonOutcomes(db: Db, anon: string, userId: number) {
  await db
    .update(t.roundOutcomes)
    .set({ playerKey: `u:${userId}`, userId })
    .where(eq(t.roundOutcomes.playerKey, `a:${anon}`));
}
