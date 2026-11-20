import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { seedCatalog } from "./catalog";
import { sha256Bytes } from "../src/auth";
import { forYouCold, forYouMix } from "../src/play/foryou";
import { getGame, putGame, type Game } from "../src/play/game";
import type { Env } from "../src/types";

const origin = "https://earshot.rising.sh";
const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE, SOLO: env.SOLO }) as Env;

const deezerTrack = (id: number, title: string) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: `https://cdn.example/${id}.mp3`,
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

function stubPreviews() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const id = Number(/track\/(\d+)/.exec(String(input))?.[1]);
      return new Response(JSON.stringify(deezerTrack(id, "x")), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function outcome(
  playerKey: string,
  deezerId: number,
  category: string,
  era: number | null,
  correct: boolean,
  answeredAt = Math.floor(Date.now() / 1000) - 86400,
) {
  await env.DB.prepare(
    `INSERT INTO round_outcomes
       (player_key, user_id, track_key, category, era, mode, kind,
        correct, elapsed_ms, answered_at)
     VALUES (?1, NULL, ?2, ?3, ?4, 'normal', 'solo', ?5, 8000, ?6)`,
  )
    .bind(
      playerKey,
      `dz:${deezerId}`,
      category,
      era,
      correct ? 1 : 0,
      answeredAt,
    )
    .run();
}

function postForYou(cookie?: string) {
  return app.fetch(
    new Request(`${origin}/play`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams({
        category: "for-you",
        mode: "normal",
      }).toString(),
    }),
    testEnv() as never,
  );
}

async function startForYou() {
  const response = await postForYou();
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/play\//);
  return location.slice(6);
}

const playIdOf = (response: Response) =>
  `__Host-play-id=${/__Host-play-id=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1]}`;

async function seedSession(githubId: number, name: string) {
  const session = `sess_${name.repeat(4)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(1, githubId, name, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
  )
    .bind(await sha256Bytes(session), now + 86400)
    .run();
  return `__Host-session=${session}`;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the For you mix", () => {
  it("draws mostly from the cell a player's outcomes concentrate in", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 15 }, (_, i) => ({
        id: 100 + i,
        title: `Pop Song ${i}`,
      })),
      1990,
    );
    await seedCatalog(
      env.DB,
      "rock",
      Array.from({ length: 15 }, (_, i) => ({
        id: 200 + i,
        title: `Rock Song ${i}`,
      })),
      1980,
    );
    const key = "a:listener";
    for (let i = 0; i < 12; i += 1)
      await outcome(key, 500 + i, "pop", 1990, false);
    const tracks = await forYouMix(testEnv(), key, null);
    expect(tracks).toHaveLength(14);
    const inCell = tracks.filter(
      (track) => track.category === "pop" && track.decade === 1990,
    );
    expect(inCell.length).toBeGreaterThanOrEqual(7);
  });

  it("finds new tracks in the playlists of correctly answered ones", async () => {
    // One source holds the answered tracks plus four the player never saw;
    // its decade is unset so the unseen tracks sit outside the top cell.
    await seedCatalog(env.DB, "pop", [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: 1 + i,
        title: `Known ${i}`,
        year: 1990,
      })),
      ...[11, 12, 13, 14].map((id) => ({
        id,
        title: `Co-listed ${id}`,
        year: 2000,
      })),
    ]);
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        title: `Other Pop ${i}`,
      })),
      1990,
    );
    const key = "a:fan";
    for (let i = 0; i < 10; i += 1)
      await outcome(key, 1 + i, "pop", 1990, true);
    const tracks = await forYouMix(testEnv(), key, null);
    const fresh = tracks.filter((track) =>
      [11, 12, 13, 14].includes(track.deezerId!),
    );
    expect(fresh.length).toBeGreaterThanOrEqual(3);
    for (const track of fresh) {
      expect(track.category).toBe("pop");
      expect(track.decade).toBe(2000);
    }
  });

  it("never serves a banned track", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 12 }, (_, i) => ({
        id: 1 + i,
        title: `Song ${i}`,
      })),
      1990,
    );
    await env.DB.prepare(
      "UPDATE catalog_tracks SET banned_at = 1 WHERE deezer_id = 5",
    ).run();
    const key = "a:regular";
    for (let i = 0; i < 12; i += 1)
      await outcome(key, 300 + i, "pop", 1990, false);
    const tracks = await forYouMix(testEnv(), key, null);
    expect(tracks.some((track) => track.deezerId === 5)).toBe(false);
    expect(tracks.length).toBeGreaterThanOrEqual(10);
  });

  it("skips tracks the player answered in the last 30 days", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 12 }, (_, i) => ({
        id: 1 + i,
        title: `Song ${i}`,
      })),
      1990,
    );
    const key = "a:tired";
    // Ten wrong answers spread across the pool mark every one recent, so the
    // mix must fall back instead of repeating them.
    for (let i = 0; i < 10; i += 1)
      await outcome(key, 1 + i, "pop", 1990, false);
    const tracks = await forYouMix(testEnv(), key, null);
    expect(tracks.some((track) => (track.deezerId ?? 0) <= 10)).toBe(false);
  });

  it("refuses to start when the pool cannot fill a game", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5, 6].map((id) => ({ id, title: `Few ${id}` })),
      1990,
    );
    const response = await postForYou();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("not available");
  });

  it("serves a full game to a player with no history", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 15 }, (_, i) => ({
        id: 1 + i,
        title: `Pop ${i}`,
      })),
      1990,
    );
    await seedCatalog(
      env.DB,
      "rock",
      Array.from({ length: 15 }, (_, i) => ({
        id: 100 + i,
        title: `Rock ${i}`,
      })),
      1980,
    );
    stubPreviews();
    const id = await startForYou();
    const game = await getGame(testEnv(), id);
    expect(game).not.toBeNull();
    expect(game!.categorySlug).toBe("for-you");
    expect(game!.categoryName).toBe("For you");
    expect(game!.candidates.length).toBeGreaterThanOrEqual(10);
  });
});

describe("the hub's For you tile", () => {
  it("tells a new player the mix learns their taste", async () => {
    const response = await app.fetch(
      new Request(`${origin}/`),
      testEnv() as never,
    );
    const body = await response.text();
    expect(body).toContain("For you");
    expect(body).toContain("Learns your taste as you play.");
    expect(body).toContain('name="category" value="for-you"');
  });

  it("turns warm once the player has enough rounds", async () => {
    const key = "a:warming";
    for (let i = 0; i < 10; i += 1)
      await outcome(key, 700 + i, "pop", 1990, false);
    expect(await forYouCold(env.DB, key, null)).toBe(false);
    expect(await forYouCold(env.DB, "a:fresh", null)).toBe(true);
  });

  it("drops a track the admin bans after the mix was cached", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 15 }, (_, i) => ({
        id: 1 + i,
        title: `Cached ${i}`,
      })),
      1990,
    );
    const first = await postForYou();
    const cookie = playIdOf(first);
    const game = await getGame(
      testEnv(),
      (first.headers.get("location") ?? "").slice(6),
    );
    const banned = game!.candidates[0]!.deezerId!;
    const admin = await app.fetch(
      new Request(`${origin}/admin/tracks/ban`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: await seedSession(42, "root"),
        },
        body: new URLSearchParams({
          category: "pop",
          track_key: `dz:${banned}`,
          ban: "1",
        }).toString(),
      }),
      { ...testEnv(), ADMIN_GITHUB_IDS: "42" } as never,
    );
    expect(admin.status).toBe(303);
    // The same anonymous player hits the cached mix; the ban must still apply.
    const second = await postForYou(cookie);
    expect(second.status).toBe(303);
    const remixed = await getGame(
      testEnv(),
      (second.headers.get("location") ?? "").slice(6),
    );
    expect(remixed!.candidates.some((track) => track.deezerId === banned)).toBe(
      false,
    );
  });

  it("shows no scores board on a finished For you game", async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      trackKey: `dz:${i}`,
      title: `Song ${i}`,
      artist: "Artist",
      cover: null,
      link: null,
      answer: `Song ${i}`,
      correct: true,
      timedOut: false,
      score: 500,
      elapsedMs: 0,
      choices: [],
    }));
    const game: Game = {
      id: "forYouFinished00000000",
      userId: 1,
      playerKey: "u:1",
      mode: "normal",
      categorySlug: "for-you",
      categoryName: "For you",
      candidates: [],
      pool: [],
      next: 10,
      served: 10,
      phase: "done",
      current: null,
      results,
      total: 5000,
    };
    await putGame(testEnv(), game);
    const response = await app.fetch(
      new Request(`${origin}/play/forYouFinished00000000`, {
        headers: { cookie: await seedSession(7, "player") },
      }),
      testEnv() as never,
    );
    const body = await response.text();
    expect(body).toContain("Game over");
    expect(body).not.toContain("Top scores");
  });
});
