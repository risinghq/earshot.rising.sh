import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { database } from "../src/platform/db";
import { seedCatalog } from "./catalog";
import { forYouMix } from "../src/play/catalog/foryou";
import {
  applyOutcomes,
  baseDifficulty,
  drawWeights,
  rebuildRatings,
  trackDifficulties,
  weightedShuffle,
  withFinale,
} from "../src/play/game/rating";
import { roundsPerGame } from "../src/play/game/rules";
import { createRoom, begin, type Stored } from "../src/play/room/game";
import type { Candidate } from "../src/play/catalog/sources";
import type { Env } from "../src/env";

const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE }) as Env;
const db = () => database(env.DB);

const candidate = (id: number): Candidate => ({
  deezerId: id,
  title: `Song ${id}`,
  artist: "Artist",
  cover: null,
  link: null,
  category: "pop",
  decade: 1990,
});

async function outcome(
  playerKey: string,
  trackId: number,
  correct: boolean,
  mode = "normal",
) {
  await env.DB.prepare(
    `INSERT INTO round_outcomes
       (player_key, user_id, track_key, category, era, mode, kind,
        correct, elapsed_ms, answered_at)
     VALUES (?1, NULL, ?2, 'pop', 1990, ?3, 'solo', ?4, 8000, 1700000000)`,
  )
    .bind(playerKey, `dz:${trackId}`, mode, correct ? 1 : 0)
    .run();
}

async function rateTrack(trackId: number, difficulty: number, answers = 5) {
  await env.DB.prepare(
    "INSERT INTO track_ratings (track_key, difficulty, answers, updated_at) VALUES (?1, ?2, ?3, 0)",
  )
    .bind(`dz:${trackId}`, difficulty, answers)
    .run();
}

async function ratePlayer(playerKey: string, skill: number, rounds = 20) {
  await env.DB.prepare(
    "INSERT INTO player_ratings (player_key, skill, rounds, updated_at) VALUES (?1, ?2, ?3, 0)",
  )
    .bind(playerKey, skill, rounds)
    .run();
}

describe("the track prior", () => {
  it("orders tracks by their streams", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Rare", streams: 1e6 },
      { id: 2, title: "Known", streams: 1e8 },
      { id: 3, title: "Hit", streams: 1e10 },
    ]);
    const items = [1, 2, 3].map((id) => ({
      key: `dz:${id}`,
      category: "pop",
    }));
    const difficulties = await trackDifficulties(db(), items);
    expect(difficulties.get("dz:3")!).toBeLessThan(difficulties.get("dz:2")!);
    expect(difficulties.get("dz:2")!).toBeLessThan(difficulties.get("dz:1")!);
  });

  it("starts a track with no count at the category mean", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Counted", streams: 1e8 },
      { id: 2, title: "Uncounted" },
    ]);
    const difficulties = await trackDifficulties(
      db(),
      [1, 2].map((id) => ({ key: `dz:${id}`, category: "pop" })),
    );
    expect(difficulties.get("dz:2")).toBe(baseDifficulty);
  });
});

describe("the finale", () => {
  it("ends the game on the most streamed early track", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 12 }, (_, i) => ({
        id: i + 1,
        title: `Song ${i + 1}`,
        streams: i === 3 ? 1e10 : 1e6 * (i + 1),
      })),
    );
    const drawn = Array.from({ length: 12 }, (_, i) => candidate(i + 1));
    const order = await withFinale(db(), drawn, (track) => ({
      key: `dz:${track.deezerId}`,
      category: "pop",
    }));
    expect(order[roundsPerGame - 1].title).toBe("Song 4");
  });
});

describe("a recorded outcome", () => {
  it("raises the player's skill and lowers the track's difficulty", async () => {
    await applyOutcomes(
      db(),
      [
        {
          playerKey: "a:p1",
          trackKey: "dz:9",
          category: "pop",
          mode: "normal",
          correct: true,
        },
      ],
      1700000000,
    );
    const player = await env.DB.prepare(
      "SELECT skill FROM player_ratings WHERE player_key = 'a:p1'",
    ).first<{ skill: number }>();
    const track = await env.DB.prepare(
      "SELECT difficulty FROM track_ratings WHERE track_key = 'dz:9'",
    ).first<{ difficulty: number }>();
    expect(player!.skill).toBeGreaterThan(0);
    expect(track!.difficulty).toBeLessThan(baseDifficulty);
  });

  it("rebuilds the ratings from every logged round outcome", async () => {
    // Five right then one wrong: skill ends above the mean.
    for (let i = 0; i < 6; i += 1) await outcome("a:veteran", 50 + i, i < 5);
    for (
      let step = 0;
      step < 10 && !(await rebuildRatings(testEnv()));
      step += 1
    );
    const state = await env.DB.prepare(
      "SELECT done_at FROM rating_state WHERE id = 1",
    ).first<{ done_at: number | null }>();
    expect(state!.done_at).not.toBeNull();
    const player = await env.DB.prepare(
      "SELECT skill, rounds FROM player_ratings WHERE player_key = 'a:veteran'",
    ).first<{ skill: number; rounds: number }>();
    expect(player!.rounds).toBe(6);
    expect(player!.skill).toBeGreaterThan(0);
    const track = await env.DB.prepare(
      "SELECT difficulty, answers FROM track_ratings WHERE track_key = 'dz:50'",
    ).first<{ difficulty: number; answers: number }>();
    expect(track!.answers).toBe(1);
    expect(track!.difficulty).toBeLessThan(baseDifficulty);
  });
});

describe("the adaptive draw", () => {
  // The target chance for a mean-skill player in normal mode.
  const targetDifficulty = -Math.log(0.7 / 0.3);
  const distant = 4;

  it("weights a track by how near its chance sits to the target", async () => {
    await rateTrack(1, targetDifficulty);
    await rateTrack(2, distant);
    const weights = await drawWeights(
      db(),
      ["a:p"],
      [
        { key: "dz:1", category: "pop" },
        { key: "dz:2", category: "pop" },
      ],
      "normal",
    );
    expect(weights[0]).toBeGreaterThan(0.99);
    expect(weights[1]).toBeLessThan(0.01);
  });

  it("aims a room at the median seated player", async () => {
    // Skills -4, 0 and 4: the median is 0, whose target sits at
    // targetDifficulty and not at either end.
    await ratePlayer("a:low", -4);
    await ratePlayer("a:mid", 0);
    await ratePlayer("a:high", 4);
    await rateTrack(1, targetDifficulty);
    await rateTrack(2, targetDifficulty - 4);
    await rateTrack(3, targetDifficulty + 4);
    const weights = await drawWeights(
      db(),
      ["a:low", "a:mid", "a:high"],
      [1, 2, 3].map((id) => ({ key: `dz:${id}`, category: "pop" })),
      "normal",
    );
    expect(weights[0]).toBeGreaterThan(weights[1]);
    expect(weights[0]).toBeGreaterThan(weights[2]);
  });

  it("draws nearer the target than a random draw", () => {
    // Equal weights shuffle; uneven weights put the likelier tracks first.
    // A constant rand makes the draw deterministic: it orders by weight.
    const items = [
      { name: "near", w: 1 },
      { name: "mid", w: 0.5 },
      { name: "far", w: 0.01 },
      { name: "far2", w: 0.01 },
    ];
    const drawn = weightedShuffle(
      items,
      (item) => item.w,
      () => 0.5,
    );
    expect(drawn.map((item) => item.name)).toEqual([
      "near",
      "mid",
      "far",
      "far2",
    ]);
  });

  it("lets For you pick the tracks nearest the target", async () => {
    // 7 of 40 tracks sit at the target. A plain draw of a game's 14 would
    // take about 2 of them; the weighted draw takes all 7.
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 40 }, (_, i) => ({
        id: 10 + i,
        title: `Pick ${i}`,
      })),
      1990,
    );
    for (let i = 0; i < 40; i += 1)
      await rateTrack(10 + i, i < 7 ? targetDifficulty : distant);
    for (let i = 0; i < 10; i += 1) await outcome("a:p", 200 + i, false);
    const tracks = await forYouMix(testEnv(), "a:p", null, "normal", () => 0.5);
    const near = tracks.filter((track) => track.deezerId! < 17);
    expect(tracks.length).toBeGreaterThanOrEqual(10);
    expect(near).toHaveLength(7);
  });

  it("starts a room game on the weighted order", async () => {
    const s: Stored = createRoom(
      {
        code: "ROOM",
        kind: "room",
        categorySlug: "pop",
        categoryName: "Pop",
        mode: "normal",
        candidates: [candidate(2), candidate(1), candidate(3)],
        creatorToken: "t",
        players: [],
      },
      0,
      () => "p1",
    );
    const order = [candidate(1), candidate(3), candidate(2)];
    const started = begin(
      s,
      0,
      { connected: new Set(), screen: false },
      "g1",
      undefined,
      () => order,
    );
    expect(started).not.toBeNull();
    expect(s.candidates.map((c) => c.deezerId)).toEqual([1, 3, 2]);
  });
});
