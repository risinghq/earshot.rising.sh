import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { seedCatalog } from "./catalog";
import { readPage } from "./html";
import { network } from "./network";
import { sha256Bytes } from "../src/account/auth";
import { database } from "../src/platform/db";
import { catalogPool, poolEras, byDecade } from "../src/play/catalog/pool";
import { catalog, warmChartCache } from "../src/play/catalog/catalog";
import { refreshCatalog, refreshSource } from "../src/play/catalog/refresh";
import curated from "../src/play/catalog/curated.json";
import seeds from "../scripts/curated-seeds.json";
import { fold, sameArtist } from "../scripts/artist-names";
import {
  eraLabel,
  eraName,
  erasCount,
  generations,
} from "../src/play/catalog/eras";
import { answerKey } from "../src/play/game/quiz";
import { mergeAnonOutcomes } from "../src/play/game/outcomes";

const origin = "https://earshot.rising.sh";
const testEnv = (extra: Record<string, unknown> = {}) =>
  ({ DB: env.DB, CACHE: env.CACHE, SOLO: env.SOLO, ...extra }) as never;

const get = (path: string, extra: Record<string, unknown> = {}) =>
  app.fetch(new Request(`${origin}${path}`), testEnv(extra) as never);

// The text a visitor reads on the page at path.
const shown = async (path: string) =>
  (await readPage(await (await get(path)).text(), origin)).text;

const post = (path: string, fields: Record<string, string>, cookie = "") =>
  app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );

describe("catalog pool", () => {
  it("unions sources and dedupes by id and answer, dropping banned tracks", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Shared", artist: "One" },
      { id: 2, title: "Single Cut", artist: "Two" },
      { id: 3, title: "Single Cut", artist: "Two" },
      { id: 4, title: "Banned", artist: "Three" },
    ]);
    // A second source repeats id 1 and adds a new track.
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Shared", artist: "One" },
      { id: 5, title: "Only Here", artist: "Four" },
    ]);
    await env.DB.prepare(
      "UPDATE catalog_tracks SET banned_at = 1 WHERE deezer_id = 4",
    ).run();
    const pool = await catalogPool(database(env.DB), "pop");
    expect(pool.map((track) => track.deezerId).sort()).toEqual([1, 2, 5]);
  });

  it("retries a curated source the bundle has no list for", async () => {
    await env.DB.prepare(
      `INSERT INTO category_sources (category, kind, ref, title, decade, position)
       VALUES ('k-pop', 'curated', 'k-pop/1990', 'Curated 1990s', 1990, 9)`,
    ).run();
    const now = 1_000_000;
    await env.DB.prepare(
      "UPDATE category_sources SET refreshed_at = ?1 WHERE ref <> 'k-pop/1990'",
    )
      .bind(now)
      .run();
    await refreshCatalog(testEnv() as never, now);
    const source = await env.DB.prepare(
      `SELECT s.refreshed_at, COUNT(m.source_id) AS members
       FROM category_sources s LEFT JOIN catalog_members m ON m.source_id = s.id
       WHERE s.ref = 'k-pop/1990' GROUP BY s.id`,
    ).first<{ refreshed_at: number; members: number }>();
    expect(source!.members).toBe(0);
    // Due again in an hour instead of a day.
    expect(source!.refreshed_at).toBe(now + 3600 - 86400);
  });

  it("keeps the answer and year overrides across a refetch", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Old Title", artist: "Artist", year: 1990 },
    ]);
    await env.DB.prepare(
      `UPDATE catalog_tracks
       SET answer_title = 'Fixed Title', answer_year = 1985, banned_at = 1
       WHERE deezer_id = 1`,
    ).run();
    network.use(
      http.get("https://api.deezer.com/*", () =>
        HttpResponse.json({
          data: [
            {
              id: 1,
              title: "New Title",
              artist: { id: 9, name: "Artist" },
              album: {},
              link: "x",
            },
          ],
        }),
      ),
    );
    const source = await env.DB.prepare(
      "SELECT * FROM category_sources WHERE category = 'pop' AND ref LIKE 'test-%'",
    ).first<{ id: number }>();
    await refreshSource(testEnv() as never, source! as never, 100);
    const track = await env.DB.prepare(
      `SELECT title, answer_title, answer_year, banned_at, artist_id
       FROM catalog_tracks WHERE deezer_id = 1`,
    ).first<{
      title: string;
      answer_title: string;
      answer_year: number;
      banned_at: number;
      artist_id: number;
    }>();
    expect(track).toMatchObject({
      title: "New Title",
      answer_title: "Fixed Title",
      answer_year: 1985,
      banned_at: 1,
      artist_id: 9,
    });
  });

  it("offers a decade only when it holds 20 playable tracks", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 20 }, (_, i) => ({
        id: i,
        title: `Ninety ${i}`,
        year: 1990 + (i % 10),
      })),
    );
    expect(poolEras(await catalogPool(database(env.DB), "pop"))).toContain(
      1990,
    );
    await env.DB.prepare(
      "DELETE FROM catalog_members WHERE track_key = 'dz:0'",
    ).run();
    expect(poolEras(await catalogPool(database(env.DB), "pop"))).not.toContain(
      1990,
    );
  });

  it("filters a pool to one decade", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Old", year: 1985 },
      { id: 2, title: "New", year: 2005 },
      { id: 3, title: "Undated" },
    ]);
    const pool = await catalogPool(database(env.DB), "pop");
    expect(byDecade(pool, 1980).map((t) => t.title)).toEqual(["Old"]);
  });

  it("takes the decade from a source playlist before the track year", async () => {
    await seedCatalog(
      env.DB,
      "k-pop",
      Array.from({ length: 20 }, (_, i) => ({
        id: 200 + i,
        title: `Kpop ${i}`,
      })),
      2000,
    );
    const pool = await catalogPool(database(env.DB), "k-pop");
    expect(poolEras(pool)).toEqual([2000]);
    expect(byDecade(pool, 2000)).toHaveLength(20);
    expect(byDecade(pool, 2010)).toHaveLength(0);
  });

  it("lets an answer-year override beat the source decade", async () => {
    await seedCatalog(env.DB, "k-pop", [{ id: 300, title: "Moved" }], 2000);
    await env.DB.prepare(
      "UPDATE catalog_tracks SET answer_year = 2012 WHERE deezer_id = 300",
    ).run();
    const pool = await catalogPool(database(env.DB), "k-pop");
    expect(byDecade(pool, 2010)).toHaveLength(1);
    expect(byDecade(pool, 2000)).toHaveLength(0);
  });
});

describe("round outcomes", () => {
  const deezerTrack = (id: number) => ({
    id,
    title: "x",
    preview: `https://cdn.example/${id}.mp3`,
    artist: { name: "Artist" },
    album: {},
  });
  // Every track lookup answers track 1, so every round plays "Song 1".
  const oneTrack = () =>
    http.get("https://api.deezer.com/track/:id", () =>
      HttpResponse.json(deezerTrack(1)),
    );

  it("writes one row for a solo answer under the anonymous key", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    network.use(oneTrack());
    const started = await post("/play", { category: "pop", mode: "normal" });
    expect(started.status).toBe(303);
    const cookie = started.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-play-id=");
    const id = started.headers.get("location")!.slice(6);
    const served = await get(`/play/${id}`);
    expect(served.status).toBe(200);
    const answered = await post(
      `/play/${id}/answer`,
      { choice: "Song 0" },
      cookie.split(";")[0],
    );
    expect(answered.status).toBe(303);
    const row = await env.DB.prepare(
      `SELECT player_key, user_id, track_key, category, kind,
              mode, correct, elapsed_ms, game_id, round, title
       FROM round_outcomes`,
    ).first<{
      player_key: string;
      user_id: number | null;
      track_key: string;
      kind: string;
      mode: string;
    }>();
    expect(row).toMatchObject({
      user_id: null,
      track_key: expect.stringMatching(/^dz:[1-4]$/),
      category: "pop",
      kind: "solo",
      mode: "normal",
      game_id: id,
      round: 1,
      title: expect.stringMatching(/^Song /),
    });
    expect(row!.player_key).toMatch(/^a:/);
    expect(
      await env.DB.prepare(
        "SELECT kind, room, category, mode, origin, players FROM games WHERE id = ?1",
      )
        .bind(id)
        .first(),
    ).toEqual({
      kind: "solo",
      room: null,
      category: "pop",
      mode: "normal",
      origin: "solo",
      players: 1,
    });
  });

  it("records the source decade, not the Deezer year, as the era", async () => {
    // Rock, not the previous test's pop: under load local KV can commit that
    // test's cached pool after test/setup.ts clears KV, and a stale pop pool
    // has no decade.
    await seedCatalog(
      env.DB,
      "rock",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}`, year: 2012 })),
      2000,
    );
    network.use(oneTrack());
    const started = await post("/play", {
      category: "rock",
      mode: "normal",
      era: "2000",
    });
    expect(started.status).toBe(303);
    const id = started.headers.get("location")!.slice(6);
    await get(`/play/${id}`);
    const cookie = started.headers.get("set-cookie") ?? "";
    await post(
      `/play/${id}/answer`,
      { choice: "Song 0" },
      cookie.split(";")[0],
    );
    const row = await env.DB.prepare("SELECT era FROM round_outcomes").first<{
      era: number;
    }>();
    expect(row!.era).toBe(2000);
  });

  it("moves anonymous outcomes to the user on sign-in", async () => {
    await env.DB.prepare(
      `INSERT INTO round_outcomes
         (player_key, user_id, track_key, category, mode, kind, correct,
          elapsed_ms, answered_at)
       VALUES ('a:abc', NULL, 'dz:1', 'pop', 'normal', 'solo', 1, 5000, 0)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (7, 7, 'u7', 0)",
    ).run();
    await mergeAnonOutcomes(database(env.DB), "abc", 7);
    const row = await env.DB.prepare(
      "SELECT player_key, user_id FROM round_outcomes",
    ).first<{ player_key: string; user_id: number }>();
    expect(row).toEqual({ player_key: "u:7", user_id: 7 });
  });
});

describe("curated sources", () => {
  it("lists each song once per category, whatever cut it came as", () => {
    const repeats: string[] = [];
    for (const [slug, decades] of Object.entries(curated)) {
      const seen = new Map<string, string>();
      const tracks: { artist: string; title: string; work?: string }[] =
        Object.values(decades).flat();
      const byTitle =
        (seeds as Record<string, { titleKey?: boolean }>)[slug]?.titleKey ===
        true;
      for (const track of tracks) {
        const title = answerKey(track.title);
        const key = byTitle ? title : `${track.artist}|${title}`;
        const held = seen.get(key);
        if (held !== undefined)
          repeats.push(`${slug}: ${held} / ${track.title}`);
        else seen.set(key, track.title);
      }
    }
    expect(repeats).toEqual([]);
  });

  it("names the show and the theme slot of anime songs", () => {
    const tracks: { title: string; work?: string; theme?: string }[] =
      Object.values(curated).flatMap((decades) =>
        Object.values(decades).flat(),
      );
    const badThemes = tracks
      .filter((track) => track.theme !== undefined)
      .filter((track) => !/^(OP|ED)\d+$/.test(track.theme!))
      .map((track) => `${track.title}: ${track.theme}`);
    expect(badThemes).toEqual([]);
    const anime: { work?: string }[] = Object.values(curated.anime).flat();
    expect(anime.filter((track) => track.work).length).toBeGreaterThan(100);
  });

  it("files K-pop by the generation of each act", () => {
    const eras = Object.keys(generations);
    expect(Object.keys(curated["k-pop"])).toEqual(eras);
    expect(Object.keys(seeds["k-pop"].generations)).toEqual(eras);
    const actsOf = (era: string) =>
      new Set(
        (seeds["k-pop"].generations as Record<string, string[]>)[era].map(
          (act) => fold(act),
        ),
      );
    const misfiled = Object.entries(curated["k-pop"]).flatMap(([era, tracks]) =>
      (tracks as { artist: string; title: string }[])
        .filter((track) => !actsOf(era).has(fold(track.artist)))
        .map((track) => `${era}: ${track.artist} | ${track.title}`),
    );
    expect(misfiled).toEqual([]);
  });

  it("labels decades and K-pop generations", () => {
    expect([1990, 2010, 1996, 2023].map(eraLabel)).toEqual([
      "90s",
      "10s",
      "1st gen",
      "5th gen",
    ]);
    expect(eraName(2000)).toBe("2000s");
    expect(erasCount([1996, 2004, 2012])).toBe("3 generations");
    expect(erasCount([1990, 2000])).toBe("2 decades");
  });

  it("matches an artist name only on whole words", () => {
    expect(sameArtist("BIGBANG", "BIGBANG (빅뱅)")).toBe(true);
    expect(sameArtist("多田葵", "多田 葵 & VISUAL ARTS / Key")).toBe(true);
    expect(sameArtist("Girls' Generation", "Girls Generation")).toBe(true);
    expect(sameArtist("Shine", "SHINee")).toBe(false);
    expect(sameArtist("Bishop Briggs", "BiSH")).toBe(false);
    expect(sameArtist("", "IU")).toBe(false);
  });

  it(
    "fills every curated source from the bundle without a request",
    {
      timeout: 60_000,
    },
    async () => {
      const [first] = curated.pop["1980"];
      await env.DB.prepare(
        `INSERT INTO catalog_tracks
         (track_key, deezer_id, title, artist, year, year_at, answer_title,
          banned_at, updated_at)
       VALUES (?1, ?2, 'Old', 'Old', 2011, 5, 'Fixed Title', 7, 0)`,
      )
        .bind(`dz:${first.id}`, first.id)
        .run();
      const asked: string[] = [];
      network.use(
        http.all("*", ({ request }) => {
          asked.push(request.url);
          return HttpResponse.json({ data: [] });
        }),
      );
      const unfilled = () =>
        env.DB.prepare(
          `SELECT COUNT(*) n FROM category_sources
         WHERE kind = 'curated' AND refreshed_at IS NULL`,
        ).first<number>("n");
      for (let run = 0; run < 20 && ((await unfilled()) ?? 0) > 0; run++)
        await refreshCatalog(testEnv() as never, 1000);
      expect(asked).toEqual([]);

      const sources = await env.DB.prepare(
        `SELECT ref, refreshed_at, tracks_count FROM category_sources
       WHERE kind = 'curated'`,
      ).all<{ ref: string; refreshed_at: number; tracks_count: number }>();
      expect(sources.results.length).toBeGreaterThan(0);
      for (const source of sources.results)
        expect(source, source.ref).toMatchObject({ refreshed_at: 1000 });
      const empty = sources.results.filter((s) => s.tracks_count < 20);
      expect(empty.map((s) => s.ref)).toEqual([]);
      expect(
        await poolEras(await catalogPool(database(env.DB), "k-pop")),
      ).toEqual(Object.keys(generations).map(Number));

      const track = await env.DB.prepare(
        `SELECT title, year, answer_title, banned_at FROM catalog_tracks
       WHERE deezer_id = ?1`,
      )
        .bind(first.id)
        .first();
      expect(track).toEqual({
        title: first.title,
        year: first.year,
        answer_title: "Fixed Title",
        banned_at: 7,
      });
    },
  );
});

describe("year backfill", () => {
  it("drops warmed pools for updated tracks when quota hits mid-run", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3].map((id) => ({ id, title: `Song ${id}` })),
    );
    const category = (await env.DB.prepare(
      "SELECT slug, name, feed, ref FROM categories WHERE slug = 'pop'",
    ).first()) as never;
    await catalog(testEnv() as never, category, null);
    let calls = 0;
    network.use(
      http.get("https://api.deezer.com/track/:id", () => {
        calls += 1;
        if (calls === 1)
          return HttpResponse.json({ id: 1, release_date: "2005-01-01" });
        return HttpResponse.json({ error: { code: 4, message: "quota" } });
      }),
    );
    const { fillMissingYears } = await import("../src/play/catalog/refresh");
    await expect(fillMissingYears(testEnv() as never)).rejects.toThrow();
    const tracks = await env.DB.prepare(
      "SELECT deezer_id, year FROM catalog_tracks WHERE deezer_id = 1",
    ).first<{ deezer_id: number; year: number }>();
    expect(tracks?.year).toBe(2005);
    const fresh = await catalog(testEnv() as never, category, null);
    expect(fresh.find((t) => t.deezerId === 1)?.year).toBe(2005);
  });
});

describe("reports", () => {
  const report = () =>
    post("/play/report", {
      track: "dz:1",
      title: "Song",
      artist: "Artist",
      category: "pop",
      reason: "bad_clip",
      back: "/play",
    });

  it("accepts a report from a signed-out player", async () => {
    const response = await report();
    expect(response.status).toBe(303);
    expect(
      await env.DB.prepare("SELECT reason FROM track_reports").first(),
    ).toEqual({ reason: "bad_clip" });
  });

  it("rate-limits reports per player key", async () => {
    for (let i = 0; i < 10; i += 1)
      await env.DB.prepare(
        `INSERT INTO track_reports
           (track_key, title, artist, reason, player_key, created_at)
         VALUES ('dz:1', 'S', 'A', 'other', 'a:x', ?1)`,
      )
        .bind(Math.floor(Date.now() / 1000))
        .run();
    const response = await app.fetch(
      new Request(`${origin}/play/report`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: "__Host-play-id=x",
        },
        body: new URLSearchParams({
          track: "dz:2",
          title: "Song",
          artist: "Artist",
          reason: "other",
        }).toString(),
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(429);
  });

  it("lets only one of two simultaneous reports take the last slot", async () => {
    for (let i = 0; i < 9; i += 1)
      await env.DB.prepare(
        `INSERT INTO track_reports
           (track_key, title, artist, reason, player_key, created_at)
         VALUES ('dz:1', 'S', 'A', 'other', 'a:', ?1)`,
      )
        .bind(Math.floor(Date.now() / 1000))
        .run();
    const statuses = await Promise.all([report(), report()]);
    expect(statuses.map((response) => response.status).sort()).toEqual([
      303, 429,
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM track_reports").first(),
    ).toEqual({ n: 10 });
  });
});

describe("admin", () => {
  const session = `sess_${"s".repeat(40)}`;
  const adminCookie = `__Host-session=${session}`;
  const adminEnv = { ADMIN_GITHUB_IDS: "42" };

  async function seedAdmin() {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 42, 'root', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
    )
      .bind(await sha256Bytes(session), now + 86400)
      .run();
  }

  it("resolves a pasted Deezer playlist URL in the source lookup", async () => {
    await seedAdmin();
    network.use(
      http.get("https://api.deezer.com/playlist/14464057043", () =>
        HttpResponse.json({ title: "K-pop 2000s", nb_tracks: 50 }),
      ),
    );
    for (const url of [
      "https://www.deezer.com/en/playlist/14464057043?utm_source=user_sharing",
      "https://www.deezer.com/playlist/14464057043/",
      "14464057043",
    ]) {
      const response = await app.fetch(
        new Request(`${origin}/admin/sources/lookup`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
            cookie: adminCookie,
          },
          body: new URLSearchParams({ category: "pop", url }).toString(),
        }),
        testEnv(adminEnv) as never,
      );
      expect(response.status).toBe(200);
      expect((await readPage(await response.text(), origin)).text).toContain(
        "K-pop 2000s",
      );
    }
  });

  it("drops a banned track from every category's cached pool", async () => {
    await seedAdmin();
    const shared = 77;
    await seedCatalog(
      env.DB,
      "pop",
      [shared, 1, 2, 3].map((id) => ({ id, title: `Pop ${id}` })),
    );
    await seedCatalog(
      env.DB,
      "rock",
      [shared, 4, 5, 6].map((id) => ({ id, title: `Rock ${id}` })),
    );
    const categories = await env.DB.prepare(
      "SELECT slug, name, feed, ref FROM categories WHERE slug IN ('pop','rock')",
    ).all<{ slug: string }>();
    const popCat = categories.results.find((c) => c.slug === "pop") as never;
    const rockCat = categories.results.find((c) => c.slug === "rock") as never;
    await catalog(testEnv() as never, popCat, null);
    expect(
      (await catalog(testEnv() as never, rockCat, null)).map((t) => t.deezerId),
    ).toContain(shared);
    const response = await app.fetch(
      new Request(`${origin}/admin/tracks/ban`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: adminCookie,
        },
        body: new URLSearchParams({
          category: "pop",
          track_key: `dz:${shared}`,
          ban: "1",
        }).toString(),
      }),
      testEnv(adminEnv) as never,
    );
    expect(response.status).toBe(303);
    const rock = await catalog(testEnv() as never, rockCat, null);
    expect(rock.map((t) => t.deezerId)).not.toContain(shared);
  });

  it("drops warmed boards when a user is hidden", async () => {
    await seedAdmin();
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (2, 2, 'bad', 1, 1)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO game_results
       (id, user_id, finished_at, category, kind, score, rank, players)
       VALUES ('r1', 2, ?1, 'pop', 'solo', 5000, 1, 1)`,
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    expect(await shown("/play/board")).toContain("bad");
    expect(await shown("/play/board?category=pop")).toContain("bad");
    const response = await app.fetch(
      new Request(`${origin}/admin/users/hide`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: adminCookie,
        },
        body: new URLSearchParams({ user_id: "2", hidden: "1" }).toString(),
      }),
      testEnv(adminEnv) as never,
    );
    expect(response.status).toBe(303);
    expect(await shown("/play/board")).not.toContain("bad");
    expect(await shown("/play/board?category=pop")).not.toContain("bad");
  });

  it("404s every admin route and POST for a non-admin", async () => {
    for (const path of [
      "/admin",
      "/admin/categories/pop",
      "/admin/categories/pop/tracks",
      "/admin/reports",
      "/admin/users",
    ]) {
      const response = await get(path, adminEnv);
      expect(response.status).toBe(404);
    }
    for (const path of [
      "/admin/categories",
      "/admin/categories/save",
      "/admin/sources/lookup",
      "/admin/sources",
      "/admin/sources/remove",
      "/admin/refresh",
      "/admin/tracks/save",
      "/admin/tracks/ban",
      "/admin/reports/resolve",
      "/admin/users/hide",
    ]) {
      const response = await app.fetch(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
          },
          body: "",
        }),
        testEnv(adminEnv) as never,
      );
      expect(response.status).toBe(404);
    }
    const foreign = await app.fetch(
      new Request(`${origin}/admin/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
        },
        body: "",
      }),
      testEnv(adminEnv) as never,
    );
    expect(foreign.status).toBe(404);
  });

  it("filters a category's tracks by decade", async () => {
    await seedAdmin();
    await seedCatalog(
      env.DB,
      "pop",
      [{ id: 1, title: "Moved", year: 2012 }],
      2000,
    );
    const page = (decade: string) =>
      app.fetch(
        new Request(`${origin}/admin/categories/pop/tracks?decade=${decade}`, {
          headers: { cookie: adminCookie },
        }),
        testEnv(adminEnv) as never,
      );
    const hit = await page("2000");
    expect(hit.status).toBe(200);
    const text = async (response: Response) =>
      (await readPage(await response.text(), origin)).text;
    expect(await text(hit)).toContain("Moved");
    const miss = await page("2010");
    expect(miss.status).toBe(200);
    expect(await text(miss)).not.toContain("Moved");
  });

  it("drops the cached pool when a source is removed", async () => {
    await seedAdmin();
    await seedCatalog(env.DB, "pop", [{ id: 1, title: "Gone" }], 2000);
    await seedCatalog(env.DB, "pop", [{ id: 2, title: "Stayed" }], 2010);
    const category = (await env.DB.prepare(
      "SELECT slug, name, feed, ref FROM categories WHERE slug = 'pop'",
    ).first()) as never;
    const before = await catalog(testEnv() as never, category, null);
    expect(before.map((track) => track.title).sort()).toEqual([
      "Gone",
      "Stayed",
    ]);
    const source = await env.DB.prepare(
      `SELECT id FROM category_sources
       WHERE category = 'pop' AND ref LIKE 'test-pop-%' ORDER BY id`,
    ).first<{ id: number }>();
    const removed = await app.fetch(
      new Request(`${origin}/admin/sources/remove`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: adminCookie,
        },
        body: new URLSearchParams({
          id: String(source!.id),
          category: "pop",
        }).toString(),
      }),
      testEnv(adminEnv) as never,
    );
    expect(removed.status).toBe(303);
    const after = await catalog(testEnv() as never, category, null);
    expect(after.map((track) => track.title)).toEqual(["Stayed"]);
  });

  it("lets an admin in and writes the action log", async () => {
    await seedAdmin();
    const home = await app.fetch(
      new Request(`${origin}/admin`, {
        headers: { cookie: adminCookie },
      }),
      testEnv(adminEnv) as never,
    );
    expect(home.status).toBe(200);
    await env.CACHE.put("play:hub", "{}");
    const saved = await app.fetch(
      new Request(`${origin}/admin/categories/save`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
          cookie: adminCookie,
        },
        body: new URLSearchParams({
          slug: "pop",
          name: "Pop Music",
          position: "10",
        }).toString(),
      }),
      testEnv(adminEnv) as never,
    );
    expect(saved.status).toBe(303);
    const action = await env.DB.prepare(
      "SELECT github_id, action, target FROM admin_actions",
    ).first<{ github_id: number; action: string; target: string }>();
    expect(action).toEqual({
      github_id: 42,
      action: "category.save",
      target: "pop",
    });
    const name = await env.DB.prepare(
      "SELECT name FROM categories WHERE slug = 'pop'",
    ).first<{ name: string }>();
    expect(name!.name).toBe("Pop Music");
    // The hub's tiles show the new name on the next visit.
    expect(await env.CACHE.get("play:hub")).toBeNull();
  });

  it("builds a category, overrides a track's answer and resolves its report", async () => {
    await seedAdmin();
    const admin = (path: string, fields: Record<string, string>) =>
      app.fetch(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin,
            cookie: adminCookie,
          },
          body: new URLSearchParams(fields).toString(),
        }),
        testEnv(adminEnv) as never,
      );
    const page = (path: string) =>
      app.fetch(
        new Request(`${origin}${path}`, { headers: { cookie: adminCookie } }),
        testEnv(adminEnv) as never,
      );

    const created = await admin("/admin/categories", {
      slug: "city-pop",
      name: "City pop",
    });
    expect(created.headers.get("location")).toBe("/admin/categories/city-pop");
    expect((await page("/admin/categories/city-pop")).status).toBe(200);
    const again = await admin("/admin/categories", {
      slug: "city-pop",
      name: "Again",
    });
    expect(again.status).toBe(400);
    const positions = await env.DB.prepare(
      "SELECT slug, position FROM categories ORDER BY position DESC LIMIT 2",
    ).all<{ slug: string; position: number }>();
    expect(positions.results[0].slug).toBe("city-pop");
    expect(positions.results[0].position).toBe(
      positions.results[1].position + 10,
    );

    const added = await admin("/admin/sources", {
      category: "city-pop",
      ref: "14464057043",
      title: "Tokyo nights",
      tracks_count: "12",
      decade: "1980",
    });
    expect(added.status).toBe(303);
    const twice = await admin("/admin/sources", {
      category: "city-pop",
      ref: "14464057043",
    });
    expect(twice.status).toBe(400);
    const sources = await env.DB.prepare(
      `SELECT ref, title, tracks_count, decade, position
       FROM category_sources WHERE category = 'city-pop'`,
    ).all();
    expect(sources.results).toEqual([
      {
        ref: "14464057043",
        title: "Tokyo nights",
        tracks_count: 12,
        decade: 1980,
        position: 0,
      },
    ]);

    await seedCatalog(env.DB, "pop", [
      { id: 5, title: "Plastic Love (Remaster)", year: 2021 },
    ]);
    const saved = await admin("/admin/tracks/save", {
      category: "pop",
      track_key: "dz:5",
      answer_title: "Plastic Love",
      answer_year: "1984",
    });
    expect(saved.headers.get("location")).toBe("/admin/categories/pop/tracks");
    const pop = (await env.DB.prepare(
      "SELECT slug, name, feed, ref FROM categories WHERE slug = 'pop'",
    ).first()) as never;
    const [track] = await catalog(testEnv() as never, pop, null);
    expect({ title: track.title, year: track.year }).toEqual({
      title: "Plastic Love",
      year: 1984,
    });
    const eighties = await page("/admin/categories/pop/tracks?decade=1980");
    expect(eighties.status).toBe(200);

    await env.DB.prepare(
      `INSERT INTO track_reports
         (id, track_key, title, artist, reason, player_key, created_at)
       VALUES (9, 'dz:5', 'Plastic Love', 'Mariya Takeuchi', 'wrong_title', 'p', 1)`,
    ).run();
    expect((await page("/admin/reports")).status).toBe(200);
    const resolved = await admin("/admin/reports/resolve", {
      id: "9",
      resolution: "fixed",
    });
    expect(resolved.status).toBe(303);
    const report = await env.DB.prepare(
      `SELECT resolved_by, resolution, resolved_at > 0 AS resolved
       FROM track_reports WHERE id = 9`,
    ).first();
    expect(report).toEqual({
      resolved_by: 42,
      resolution: "fixed",
      resolved: 1,
    });

    const log = await env.DB.prepare(
      "SELECT action FROM admin_actions ORDER BY id",
    ).all<{ action: string }>();
    expect(log.results.map((row) => row.action)).toEqual([
      "category.create",
      "source.add",
      "track.save",
      "report.resolve",
    ]);
  });

  it("finds users by name for an admin", async () => {
    await seedAdmin();
    await env.DB.prepare(
      `INSERT INTO users (id, github_id, name, is_public, created_at)
       VALUES (2, 2, 'mira', 0, 1), (3, 3, 'otto', 1, 1)`,
    ).run();
    // The users the page offers to hide, in the order it lists them.
    const listed = async (q: string) => {
      const response = await app.fetch(
        new Request(`${origin}/admin/users?q=${q}`, {
          headers: { cookie: adminCookie },
        }),
        testEnv(adminEnv) as never,
      );
      const page = await readPage(await response.text(), origin);
      return page.forms
        .filter((form) => form.action === `${origin}/admin/users/hide`)
        .map((form) => form.fields.user_id);
    };
    expect(await listed("")).toEqual(["2", "3", "1"]);
    expect(await listed("ir")).toEqual(["2"]);
  });
});

describe("chart warming", () => {
  it("loads one cold chart per run and shows its covers on the home tile", async () => {
    const requested: string[] = [];
    network.use(
      http.get(/\/api\/v2\/\w+\//, ({ request }) => {
        const url = request.url;
        requested.push(url);
        const country = /api\/v2\/(\w+)\//.exec(url)?.[1] ?? "xx";
        return HttpResponse.json({
          feed: {
            results: [1, 2, 3, 4].map((n) => ({
              name: `Song ${n}`,
              artistName: `Artist ${n}`,
              artworkUrl100: `https://art.example/${country}-${n}.jpg`,
            })),
          },
        });
      }),
    );
    await warmChartCache(testEnv() as never);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/jp/");
    await warmChartCache(testEnv() as never);
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain("/pe/");

    expect(await env.CACHE.get("play:cat:top-50-japan")).toContain(
      "https://art.example/jp-1.jpg",
    );
  });
});
