import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import {
  catalog,
  getCategory,
  interleave,
  parseArtistSlug,
} from "../src/play/catalog";
import { readCategoryBoard } from "../src/play/results";

const origin = "https://earshot.rising.sh";
const testEnv = () => env;

const deezerTrack = (id: number, title: string, preview = true) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: preview ? `https://cdn.example/${id}.mp3` : "",
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

const deezerArtist = (id: number, name: string, fans = 1000) => ({
  id,
  name,
  nb_fan: fans,
  picture_medium: `https://img.example/${id}.jpg`,
});

function stubFetch(
  handlers: Array<[RegExp, unknown | ((url: string) => unknown)]>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      for (const [pattern, body] of handlers) {
        if (pattern.test(url)) {
          const data = typeof body === "function" ? body(url) : body;
          return new Response(JSON.stringify(data), {
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

const post = (path: string, fields: Record<string, string>) =>
  app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );

const get = (path: string) =>
  app.fetch(new Request(`${origin}${path}`), testEnv() as never);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("artist slugs", () => {
  it("parses solo and blended slugs and rejects malformed ones", () => {
    expect(parseArtistSlug("artist-27")).toEqual([27]);
    expect(parseArtistSlug("artist-27-85")).toEqual([27, 85]);
    expect(parseArtistSlug("artist-5-5")).toEqual([5]);
    expect(parseArtistSlug("artist-007")).toEqual([7]);
    for (const slug of [
      "artist-",
      "artist-abc",
      "artist-1-2-3",
      "artist-x-27",
      "artist--27",
    ])
      expect(parseArtistSlug(slug)).toBeNull();
  });

  it("resolves a solo slug through Deezer for the display name", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
    ]);
    const category = await getCategory(testEnv() as never, "artist-27");
    expect(category).toEqual({
      slug: "artist-27",
      name: "Radiohead",
      feed: "deezer_artist",
      ref: "27",
    });
  });

  it("resolves a blended slug to both names and normalizes it", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
      [/api\.deezer\.com\/artist\/85$/, deezerArtist(85, "Portishead")],
    ]);
    const category = await getCategory(testEnv() as never, "artist-27-85");
    expect(category?.slug).toBe("artist-27-85");
    expect(category?.name).toBe("Radiohead × Portishead");
    expect(category?.ref).toBe("27,85");
  });

  it("sorts a blend's ids, so both orders are one canonical category", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
      [/api\.deezer\.com\/artist\/85$/, deezerArtist(85, "Portishead")],
    ]);
    expect(parseArtistSlug("artist-85-27")).toEqual([27, 85]);
    const category = await getCategory(testEnv() as never, "artist-85-27");
    expect(category?.slug).toBe("artist-27-85");
    const response = await get("/play/artist/85-27");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/play/artist/27-85");
  });

  it("returns null for a malformed artist slug, so the routes answer 404", async () => {
    expect(await getCategory(testEnv() as never, "artist-abc")).toBeNull();
    const response = await post("/play", {
      category: "artist-abc",
      mode: "hard",
    });
    expect(response.status).toBe(404);
    const start = await get("/play/artist/abc");
    expect(start.status).toBe(404);
  });
});

describe("artist search", () => {
  it("sorts hits by fans, not by Deezer's own order", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/search\/artist/,
        {
          data: [
            deezerArtist(11, "BTS Tribute", 120),
            deezerArtist(12, "bts cover band", 40),
            deezerArtist(13, "BTS", 3_900_000),
          ],
        },
      ],
    ]);
    const response = await get("/play/artists?q=bts");
    expect(response.status).toBe(200);
    const body = await response.text();
    const real = body.indexOf("BTS</b>");
    const tribute = body.indexOf("BTS Tribute");
    const cover = body.indexOf("bts cover band");
    expect(real).toBeGreaterThan(-1);
    expect(real).toBeLessThan(tribute);
    expect(tribute).toBeLessThan(cover);
    expect(body).toContain("3,900,000 fans");
    expect(body).toContain("/play/artist/13");
  });

  it("keeps the first pick in the blend links", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/search\/artist/,
        { data: [deezerArtist(85, "Portishead", 500_000)] },
      ],
    ]);
    const response = await get(
      "/play/artists?q=portishead&with=27&n=Radiohead",
    );
    const body = await response.text();
    expect(body).toContain("Blending with Radiohead");
    expect(body).toContain("/play/artist/27-85");
  });
});

describe("deezer_artist feed", () => {
  it("interleaves two artists evenly, longer tail last", () => {
    const a = [1, 2, 3, 4].map((i) => ({
      title: `A${i}`,
      artist: "A",
      cover: null,
      link: null,
    }));
    const b = [1, 2].map((i) => ({
      title: `B${i}`,
      artist: "B",
      cover: null,
      link: null,
    }));
    expect(interleave([a, b]).map((track) => track.title)).toEqual([
      "A1",
      "B1",
      "A2",
      "B2",
      "A3",
      "A4",
    ]);
  });

  it("builds a blended catalog from both artists' top tracks", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/artist\/1\/top/,
        { data: [1, 2, 3].map((i) => deezerTrack(i, `A${i}`)) },
      ],
      [
        /api\.deezer\.com\/artist\/2\/top/,
        { data: [11, 12].map((i) => deezerTrack(i, `B${i}`)) },
      ],
    ]);
    const tracks = await catalog(
      testEnv() as never,
      {
        slug: "artist-1-2",
        name: "A × B",
        feed: "deezer_artist",
        ref: "1,2",
      },
      null,
    );
    expect(tracks.map((track) => track.title)).toEqual([
      "A1",
      "B11",
      "A2",
      "B12",
      "A3",
    ]);
  });

  it("plays each song once, as its plainest release, where it first ranks", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/artist\/3\/top/,
        {
          data: [
            deezerTrack(1, "BOOMPALA (SAKURA ver.)"),
            deezerTrack(2, "Perfect Night"),
            deezerTrack(3, "BOOMPALA"),
            deezerTrack(4, "CRAZY (David Guetta Remix) - Extended ver."),
            deezerTrack(5, "BOOMPALA"),
            deezerTrack(6, "Perfect Night (Instrumental)"),
            deezerTrack(7, "Live My Life"),
          ],
        },
      ],
    ]);
    const tracks = await catalog(
      testEnv() as never,
      { slug: "artist-3", name: "C", feed: "deezer_artist", ref: "3" },
      null,
    );
    expect(tracks.map((track) => track.title)).toEqual([
      "BOOMPALA",
      "Perfect Night",
      "CRAZY (David Guetta Remix) - Extended ver.",
      "Live My Life",
    ]);
  });

  it("answers not found for an id Deezer says is unknown", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/999\/top/, { error: { code: 800 } }],
      [/api\.deezer\.com\/artist\/999$/, { error: { code: 800 } }],
    ]);
    const start = await get("/play/artist/999");
    expect(start.status).toBe(404);
    const response = await post("/play", {
      category: "artist-999",
      mode: "hard",
    });
    expect(response.status).toBe(404);
  });

  it("keeps the fallback name for a busy or failed lookup, not a 404", async () => {
    stubFetch([[/api\.deezer\.com\/artist\/999$/, { error: { code: 700 } }]]);
    const busy = await get("/play/artist/999");
    expect(busy.status).toBe(200);
    expect(await busy.text()).toContain("Artist 999");
    const category = await getCategory(testEnv() as never, "artist-999");
    expect(category?.name).toBe("Artist 999");
    const dead = await get("/play/artist/888");
    expect(dead.status).toBe(200);
    expect(await dead.text()).toContain("Artist 888");
  });

  it("rejects a blend when one artist's top list is empty", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/artist\/27\/top/,
        { data: Array.from({ length: 12 }, (_, i) => deezerTrack(i, `S${i}`)) },
      ],
      // Only the top endpoint is stubbed, so the name lookup fails with a 404
      // fetch and the category keeps the fallback name.
      [/api\.deezer\.com\/artist\/999\/top/, { error: { code: 800 } }],
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
      [/api\.deezer\.com\/artist\/888\/top/, { data: [] }],
      [/api\.deezer\.com\/artist\/888$/, deezerArtist(888, "Empty Artist")],
    ]);
    const unknown = await post("/play", {
      category: "artist-27-999",
      mode: "hard",
    });
    expect(unknown.status).toBe(502);
    expect(await unknown.text()).toContain("is not available right now");
    const empty = await post("/play", {
      category: "artist-27-888",
      mode: "hard",
    });
    expect(empty.status).toBe(502);
    expect(await empty.text()).toContain("is not available right now");
  });

  it("rejects an artist with fewer than four distinct titles", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/artist\/5\/top/,
        {
          data: [
            deezerTrack(1, "Same Song"),
            deezerTrack(2, "Same Song (Live)"),
            deezerTrack(3, "Second"),
            deezerTrack(4, "Third"),
            deezerTrack(5, "Same Song"),
          ],
        },
      ],
      [/api\.deezer\.com\/artist\/5$/, deezerArtist(5, "Thin Artist")],
    ]);
    const response = await post("/play", {
      category: "artist-5",
      mode: "hard",
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain(
      "Thin Artist is not available right now",
    );
  });
});

describe("artist categories in rooms and matches", () => {
  const topTracks = (id: number) => ({
    data: Array.from({ length: 12 }, (_, i) =>
      deezerTrack(id * 100 + i, `Song ${i}`),
    ),
  });

  it("starts a room on an artist slug", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/27\/top/, topTracks(27)],
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
    ]);
    const response = await post("/play/room", {
      category: "artist-27",
      mode: "normal",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(
      /^\/play\/room\/[A-Z2-9]+\?k=/,
    );
  });

  it("accepts an artist slug for a random match", async () => {
    stubFetch([
      [/api\.deezer\.com\/artist\/27\/top/, topTracks(27)],
      [/api\.deezer\.com\/artist\/27$/, deezerArtist(27, "Radiohead")],
    ]);
    const queued = await post("/play/match", { category: "artist-27" });
    expect(queued.status).toBe(303);
    expect(queued.headers.get("location")).toBe("/play/match/artist-27");
    const page = await get("/play/match/artist-27");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Radiohead");
  });
});

describe("category board", () => {
  async function addUser(id: number, name: string, isPublic = 1) {
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
      .bind(id, id, name, isPublic, 1)
      .run();
  }

  async function addResult(
    userId: number,
    category: string,
    finishedAt: number,
    score: number,
  ) {
    await env.DB.prepare(
      `INSERT INTO game_results
       (id, user_id, finished_at, category, kind, score, rank, players)
       VALUES (?1, ?2, ?3, ?4, 'solo', ?5, 1, 1)`,
    )
      .bind(
        `t:${userId}:${category}:${finishedAt}`,
        userId,
        finishedAt,
        category,
        score,
      )
      .run();
  }

  it("shows each public user's best score inside the window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inside = now - 86400;
    const outside = now - 16 * 86400;
    await addUser(1, "ann");
    await addUser(2, "bob");
    await addUser(3, "shy", 0);
    await addResult(1, "pop", inside, 5000);
    await addResult(1, "pop", inside + 10, 3000);
    await addResult(1, "pop", outside, 9000);
    await addResult(1, "artist-27", inside, 8000);
    await addResult(2, "pop", inside, 2000);
    await addResult(3, "pop", inside, 9999);
    const entries = await readCategoryBoard(testEnv() as never, "pop");
    // The other columns come from the best game, not the latest one.
    expect(entries).toEqual([
      {
        name: "ann",
        score: 5000,
        correct: null,
        rounds: null,
        finished_at: inside,
      },
      {
        name: "bob",
        score: 2000,
        correct: null,
        rounds: null,
        finished_at: inside,
      },
    ]);
    const weekly = await (await get("/play/board")).text();
    expect(weekly).toContain("/play/board?category=pop");
    const board = await (await get("/play/board?category=pop")).text();
    expect(board).toContain("/u/ann");
    expect(board).toContain("5,000");
  });

  it("boards artist slugs like any category and shows them on /play", async () => {
    const now = Math.floor(Date.now() / 1000);
    await addUser(1, "ann");
    await addResult(1, "artist-27", now - 60, 4300);
    await addResult(1, "pop", now - 60, 6100);
    const entries = await readCategoryBoard(testEnv() as never, "artist-27");
    expect(entries).toMatchObject([{ name: "ann", score: 4300 }]);
    // Tiles show the name and eras only; scores live one click away on the board.
    const body = await (await get("/")).text();
    expect(body).not.toContain("/u/ann");
    expect(body).not.toContain("6,100");
  });
});
