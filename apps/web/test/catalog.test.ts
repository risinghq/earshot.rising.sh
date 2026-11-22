import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { seedCatalog } from "./catalog";
import { sha256Bytes } from "../src/auth";
import { catalogPool, poolEras, byDecade } from "../src/play/pool";
import { catalog, warmChartCache } from "../src/play/catalog";
import { refreshCatalog, refreshSource } from "../src/play/refresh";
import curated from "../src/play/curated.json";
import seeds from "../scripts/curated-seeds.json";
import { fold, sameArtist } from "../scripts/artist-names";
import { eraLabel, eraName, erasCount, generations } from "../src/play/eras";
import { answerKey } from "../src/play/quiz";
import { mergeAnonOutcomes } from "../src/play/outcomes";

const origin = "https://earshot.rising.sh";
const testEnv = (extra: Record<string, unknown> = {}) =>
  ({ DB: env.DB, CACHE: env.CACHE, SOLO: env.SOLO, ...extra }) as never;

const get = (path: string, extra: Record<string, unknown> = {}) =>
  app.fetch(new Request(`${origin}${path}`), testEnv(extra) as never);

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

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
}, 20000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    const pool = await catalogPool(env.DB, "pop");
    expect(pool.map((track) => track.deezerId).sort()).toEqual([1, 2, 5]);
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
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
    expect(poolEras(await catalogPool(env.DB, "pop"))).toContain(1990);
    await env.DB.prepare(
      "DELETE FROM catalog_members WHERE track_key = 'dz:0'",
    ).run();
    expect(poolEras(await catalogPool(env.DB, "pop"))).not.toContain(1990);
  });

  it("filters a pool to one decade", async () => {
    await seedCatalog(env.DB, "pop", [
      { id: 1, title: "Old", year: 1985 },
      { id: 2, title: "New", year: 2005 },
      { id: 3, title: "Undated" },
    ]);
    const pool = await catalogPool(env.DB, "pop");
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
    const pool = await catalogPool(env.DB, "k-pop");
    expect(poolEras(pool)).toEqual([2000]);
    expect(byDecade(pool, 2000)).toHaveLength(20);
    expect(byDecade(pool, 2010)).toHaveLength(0);
  });

  it("lets an answer-year override beat the source decade", async () => {
    await seedCatalog(env.DB, "k-pop", [{ id: 300, title: "Moved" }], 2000);
    await env.DB.prepare(
      "UPDATE catalog_tracks SET answer_year = 2012 WHERE deezer_id = 300",
    ).run();
    const pool = await catalogPool(env.DB, "k-pop");
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

  it("writes one row for a solo answer under the anonymous key", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(deezerTrack(1))),
    );
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
    // test's cached pool after reset(), and a stale pop pool has no decade.
    await seedCatalog(
      env.DB,
      "rock",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}`, year: 2012 })),
      2000,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(deezerTrack(1))),
    );
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
    await mergeAnonOutcomes(env.DB, "abc", 7);
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
      const fetch = vi.fn(async () => Response.json({ data: [] }));
      vi.stubGlobal("fetch", fetch);
      const unfilled = () =>
        env.DB.prepare(
          `SELECT COUNT(*) n FROM category_sources
         WHERE kind = 'curated' AND refreshed_at IS NULL`,
        ).first<number>("n");
      for (let run = 0; run < 20 && ((await unfilled()) ?? 0) > 0; run++)
        await refreshCatalog(testEnv() as never, 1000);
      expect(fetch).not.toHaveBeenCalled();

      const sources = await env.DB.prepare(
        `SELECT ref, refreshed_at, tracks_count FROM category_sources
       WHERE kind = 'curated'`,
      ).all<{ ref: string; refreshed_at: number; tracks_count: number }>();
      expect(sources.results.length).toBeGreaterThan(0);
      for (const source of sources.results)
        expect(source, source.ref).toMatchObject({ refreshed_at: 1000 });
      const empty = sources.results.filter((s) => s.tracks_count < 20);
      expect(empty.map((s) => s.ref)).toEqual([]);
      expect(await poolEras(await catalogPool(env.DB, "k-pop"))).toEqual(
        Object.keys(generations).map(Number),
      );

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/track/")) {
          calls += 1;
          if (calls === 1)
            return Response.json({ id: 1, release_date: "2005-01-01" });
          return Response.json({ error: { code: 4, message: "quota" } });
        }
        return Response.json({ data: [] });
      }),
    );
    const { fillMissingYears } = await import("../src/play/refresh");
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/playlist/14464057043"))
          return Response.json({ title: "K-pop 2000s", nb_tracks: 50 });
        return new Response("not found", { status: 404 });
      }),
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
      expect(await response.text()).toContain("K-pop 2000s");
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
    expect(await (await get("/play/board")).text()).toContain("bad");
    expect(await (await get("/play/board?category=pop")).text()).toContain(
      "bad",
    );
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
    expect(await (await get("/play/board")).text()).not.toContain("bad");
    expect(await (await get("/play/board?category=pop")).text()).not.toContain(
      "bad",
    );
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
    expect(await hit.text()).toContain("Moved");
    const miss = await page("2010");
    expect(miss.status).toBe(200);
    expect(await miss.text()).not.toContain("Moved");
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
  });
});

describe("chart warming", () => {
  it("loads one cold chart per run and shows its covers on the home tile", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        const country = /api\/v2\/(\w+)\//.exec(url)?.[1] ?? "xx";
        return Response.json({
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
