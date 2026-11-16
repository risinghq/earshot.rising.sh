import type { Env } from "../types";
import { putGame, type Game } from "./game";

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
}

// The row id is the game's identity for that player, so a finish processed
// twice — a re-fired alarm, a repeated request — inserts nothing the second
// time.
export async function recordResults(env: Env, rows: ResultRow[]) {
  if (rows.length === 0) return;
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO game_results
         (id, user_id, finished_at, category, kind, score, rank, players)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        row.id,
        row.userId,
        row.finishedAt,
        row.category,
        row.kind,
        row.score,
        row.rank,
        row.players,
      ),
    ),
  );
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

export async function readBoard(env: Env, period: BoardPeriod) {
  const key = `play:board:${period}`;
  const cached = await env.CACHE?.get<BoardEntry[]>(key, "json").catch(
    () => null,
  );
  if (cached) return cached;
  const since = period === "week" ? weekStart(Date.now() / 1000) : 0;
  const rows = await env.DB.prepare(
    `SELECT users.name,
            SUM(game_results.score) AS points,
            SUM(CASE WHEN game_results.kind IN ('match', 'room')
                      AND game_results.rank = 1
                      AND game_results.players > 1 THEN 1 ELSE 0 END) AS wins
     FROM game_results
     JOIN users ON users.id = game_results.user_id
     WHERE users.is_public = 1 AND game_results.finished_at >= ?1
     GROUP BY game_results.user_id
     ORDER BY points DESC, users.name
     LIMIT 50`,
  )
    .bind(since)
    .all<BoardEntry>();
  const entries = rows.results;
  if (env.CACHE)
    await env.CACHE.put(key, JSON.stringify(entries), {
      expirationTtl: boardTtlSeconds,
    }).catch(() => undefined);
  return entries;
}

export interface CategoryBoardEntry {
  name: string;
  score: number;
}

export const categoryBoardDays = 15;
export const categoryBoardSize = 10;

// Each player appears once with the best score they set in the window, so a
// category board is a list of people, not of games.
export async function readCategoryBoard(env: Env, slug: string) {
  const key = `play:catboard:${slug}`;
  const cached = await env.CACHE?.get<CategoryBoardEntry[]>(key, "json").catch(
    () => null,
  );
  if (cached) return cached;
  const since = Math.floor(Date.now() / 1000) - categoryBoardDays * 86400;
  const rows = await env.DB.prepare(
    `SELECT users.name, MAX(game_results.score) AS score
     FROM game_results
     JOIN users ON users.id = game_results.user_id
     WHERE users.is_public = 1
       AND game_results.category = ?1
       AND game_results.finished_at >= ?2
     GROUP BY game_results.user_id
     ORDER BY score DESC, users.name
     LIMIT ?3`,
  )
    .bind(slug, since, categoryBoardSize)
    .all<CategoryBoardEntry>();
  const entries = rows.results;
  if (env.CACHE)
    await env.CACHE.put(key, JSON.stringify(entries), {
      expirationTtl: boardTtlSeconds,
    }).catch(() => undefined);
  return entries;
}
