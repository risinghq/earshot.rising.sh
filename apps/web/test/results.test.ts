// The result rows a finished game writes to D1, and the boards read from
// them. Which players get a row is a room rule, tested in room-game.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  readBoard,
  readCategoryBoard,
  recordResults,
  type ResultRow,
} from "../src/play/game/results";

const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE }) as never;

const now = () => Math.floor(Date.now() / 1000);

async function addUser(id: number, name: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (?1, ?1, ?2, 1, 1)",
  )
    .bind(id, name)
    .run();
}

const row = (over: Partial<ResultRow>): ResultRow => ({
  id: "r:game:1",
  userId: 1,
  finishedAt: now(),
  category: "pop",
  kind: "match",
  score: 4000,
  rank: 1,
  players: 2,
  correct: 4,
  rounds: 4,
  ...over,
});

describe("game results", () => {
  it("writes a finished game once, however often the finish is processed", async () => {
    await addUser(1, "ann");
    await recordResults(testEnv(), [row({})]);
    await recordResults(testEnv(), [row({ score: 9999 })]);
    expect(await readBoard(testEnv(), "week")).toEqual([
      { name: "ann", points: 4000, wins: 1 },
    ]);
  });

  it("counts a win only against another player", async () => {
    await addUser(1, "ann");
    await recordResults(testEnv(), [
      row({ id: "r:solo:1", players: 1 }),
      row({ id: "r:lost:1", rank: 2 }),
    ]);
    expect(await readBoard(testEnv(), "week")).toEqual([
      { name: "ann", points: 8000, wins: 0 },
    ]);
  });

  it("refreshes a cached category board when results are written", async () => {
    await addUser(1, "pro");
    const finishedAt = now();
    // The board was read right before the game: its cache holds a stale,
    // empty copy that must not survive the result write.
    await env.CACHE.put("play:catboard:pop", JSON.stringify([]));
    await recordResults(testEnv(), [
      row({ kind: "room", finishedAt, score: 5000, correct: 7, rounds: 10 }),
    ]);
    expect(await readCategoryBoard(testEnv(), "pop")).toEqual([
      {
        name: "pro",
        score: 5000,
        correct: 7,
        rounds: 10,
        finished_at: finishedAt,
      },
    ]);
  });
});
