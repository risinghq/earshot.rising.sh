import { and, desc, eq, gte, sql } from "drizzle-orm";
import { batchWrites, database, t } from "../../platform/db";
import type { Env } from "../../env";
import { putGame, type Game } from "./game";
import { playerKeyOf } from "./outcomes";
import type { CategoryBoardEntry } from "../room/protocol";

export type GameKind = "solo" | "room" | "match";

export interface ResultRow {
  id: string;
  userId: number;
  finishedAt: number;
  category: string;
  kind: GameKind;
  score: number;
  rank: number;
  players: number;
  correct: number;
  rounds: number;
}

// The row id is the game's identity for that player, so a finish processed
// twice — a re-fired alarm, a repeated request — inserts nothing the second
// time.
export async function recordResults(env: Env, rows: ResultRow[]) {
  if (rows.length === 0) return;
  const db = database(env.DB);
  // One statement per row: D1 binds at most 100 values per statement.
  await batchWrites(
    db,
    rows.map((row) =>
      db.insert(t.gameResults).values(row).onConflictDoNothing(),
    ),
  );
  // A written result changes its category's board, so the cached copy must
  // not survive the write — a room finishing right after a board read would
  // otherwise freeze the board without its own scores.
  const categories = new Set(rows.map((row) => row.category));
  await Promise.all(
    [...categories].map((category) =>
      env.CACHE.delete(categoryBoardKey(category)).catch(() => undefined),
    ),
  );
}

const boardKey = (period: BoardPeriod) => `play:board:${period}`;
const categoryBoardKey = (slug: string) => `play:catboard:${slug}`;

// Hiding or showing a player changes every board they appear on.
export async function forgetBoardsOf(env: Env, userId: number) {
  const played = await database(env.DB)
    .selectDistinct({ category: t.gameResults.category })
    .from(t.gameResults)
    .where(eq(t.gameResults.userId, userId));
  const keys = [
    boardKey("week"),
    boardKey("all"),
    ...played.map((row) => categoryBoardKey(row.category)),
  ];
  await Promise.all(
    keys.map((key) => env.CACHE.delete(key).catch(() => undefined)),
  );
}

// A guest who signs in from the game-over page keeps the game they just
// played: sign-in keeps the browser's anonymous id, and that id is the
// game's player key. Returns whether the game changed hands.
export function claimGame(game: Game, userId: number, anon: string | null) {
  if (game.userId || anon === null || game.phase !== "done") return false;
  if (game.playerKey !== playerKeyOf(null, anon)) return false;
  game.userId = userId;
  return true;
}

// Writes the row at the finish transition only; the flag in KV turns every
// later call — a final-page reload — into a no-op before any D1 traffic.
export async function recordGame(env: Env, game: Game) {
  if (
    !game.userId ||
    game.phase !== "done" ||
    game.results.length === 0 ||
    game.resultWritten === true
  )
    return;
  await recordResults(env, [
    {
      id: `s:${game.id}:${game.userId}`,
      userId: game.userId,
      finishedAt: Math.floor(Date.now() / 1000),
      category: game.categorySlug,
      kind: "solo",
      score: game.total,
      rank: 1,
      players: 1,
      correct: game.results.filter((result) => result.correct).length,
      rounds: game.results.length,
    },
  ]);
  game.resultWritten = true;
  await putGame(env, game);
}

export type BoardPeriod = "week" | "all";

export interface BoardEntry {
  name: string;
  points: number;
  wins: number;
}

// The board week starts Monday 00:00 UTC, matching the note on the page.
export function weekStart(nowSeconds: number) {
  const day = Math.floor(nowSeconds / 86400);
  const monday = day - ((day + 3) % 7);
  return monday * 86400;
}

const boardTtlSeconds = 300;

// Boards list public players an admin has not hidden.
const listedPlayer = and(eq(t.users.isPublic, 1), eq(t.users.adminHidden, 0));

export async function readBoard(env: Env, period: BoardPeriod) {
  const key = boardKey(period);
  const cached = await env.CACHE.get<BoardEntry[]>(key, "json").catch(
    () => null,
  );
  if (cached) return cached;
  const since = period === "week" ? weekStart(Date.now() / 1000) : 0;
  const gr = t.gameResults;
  const points = sql<number>`SUM(${gr.score})`;
  const entries: BoardEntry[] = await database(env.DB)
    .select({
      name: t.users.name,
      points,
      wins: sql<number>`SUM(CASE WHEN ${gr.kind} IN ('match', 'room')
        AND ${gr.rank} = 1 AND ${gr.players} > 1 THEN 1 ELSE 0 END)`,
    })
    .from(gr)
    .innerJoin(t.users, eq(t.users.id, gr.userId))
    .where(and(listedPlayer, gte(gr.finishedAt, since)))
    .groupBy(gr.userId)
    .orderBy(desc(points), t.users.name)
    .limit(50);
  await env.CACHE.put(key, JSON.stringify(entries), {
    expirationTtl: boardTtlSeconds,
  }).catch(() => undefined);
  return entries;
}

export type { CategoryBoardEntry };

export const categoryBoardDays = 15;
export const categoryBoardSize = 10;

// Each player appears once with the best score they set in the window, so a
// category board is a list of people, not of games.
export async function readCategoryBoard(env: Env, slug: string) {
  const key = categoryBoardKey(slug);
  const cached = await env.CACHE.get<CategoryBoardEntry[]>(key, "json").catch(
    () => null,
  );
  if (cached) return cached;
  const since = Math.floor(Date.now() / 1000) - categoryBoardDays * 86400;
  // SQLite fills bare columns beside a lone MAX() from the row that holds the
  // maximum, so correct, rounds and finished_at describe the best game.
  const gr = t.gameResults;
  const best = sql<number>`MAX(${gr.score})`;
  const entries: CategoryBoardEntry[] = await database(env.DB)
    .select({
      name: t.users.name,
      score: best,
      correct: gr.correct,
      rounds: gr.rounds,
      finished_at: gr.finishedAt,
    })
    .from(gr)
    .innerJoin(t.users, eq(t.users.id, gr.userId))
    .where(and(listedPlayer, eq(gr.category, slug), gte(gr.finishedAt, since)))
    .groupBy(gr.userId)
    .orderBy(desc(best), t.users.name)
    .limit(categoryBoardSize);
  await env.CACHE.put(key, JSON.stringify(entries), {
    expirationTtl: boardTtlSeconds,
  }).catch(() => undefined);
  return entries;
}
