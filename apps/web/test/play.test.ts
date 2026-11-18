import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { seedCatalog } from "./catalog";
import {
  advance,
  answerRound,
  buildGame,
  getGame,
  prepareNext,
  matchTyped,
  putGame,
  roundsPerGame,
  scoreFor,
  serveRound,
} from "../src/play/game";
import type { Candidate } from "../src/play/sources";

const origin = "https://earshot.rising.sh";
const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE });

const deezerTrack = (id: number, title: string, preview = true) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: preview ? `https://cdn.example/${id}.mp3` : "",
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

const appleChartEntry = (i: number) => ({
  id: `apple-${i}`,
  name: `Chart Song ${i}`,
  artistName: "Chart Artist",
  url: `https://music.apple.com/song/${i}`,
  artworkUrl100: `https://img.example/${i}.jpg`,
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

async function startGame(slug: string, mode: string) {
  const response = await app.fetch(
    new Request(`${origin}/play`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({ category: slug, mode }).toString(),
    }),
    testEnv() as never,
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  expect(location).toMatch(/^\/play\//);
  return location.slice(6);
}

async function answer(id: string, fields: Record<string, string>) {
  return app.fetch(
    new Request(`${origin}/play/${id}/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );
}

async function playing(id: string) {
  return app.fetch(
    new Request(`${origin}/play/${id}/playing`, {
      method: "POST",
      headers: { origin },
    }),
    testEnv() as never,
  );
}

async function next(id: string) {
  return app.fetch(
    new Request(`${origin}/play/${id}/next`, {
      method: "POST",
      headers: { origin },
    }),
    testEnv() as never,
  );
}

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

describe("/play", () => {
  it("carries the site nav", async () => {
    const response = await get("/play");
    const body = await response.text();
    expect(body).toContain('class="site-nav"');
    for (const href of ["/play", "/play/board", "/groups", "/auth/github"])
      expect(body).toContain(`href="${href}"`);
  });

  it("lists the seeded categories", async () => {
    const response = await get("/play");
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const name of [
      "Pop",
      "Rock",
      "Metal",
      "K-pop",
      "Anime",
      "Top 50 Japan",
      "Top 50 Peru",
      "Top 50 Global",
      "From my listening",
    ])
      expect(body).toContain(name);
  });

  it("builds a game whose rounds have previews, skipping tracks without one", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 12 }, (_, i) => ({
        id: 100 + i,
        title: `Song ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/(\d+)/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, "x", id % 2 === 0);
        },
      ],
    ]);
    const id = await startGame("pop", "typed");
    const response = await get(`/play/${id}`);
    expect(response.status).toBe(200);
    const game = await getGame(testEnv() as never, id);
    expect(game).not.toBeNull();
    const served = game!.candidates[game!.current!.index];
    expect(Number(served.title.replace("Song ", "")) % 2).toBe(0);
  });

  it("serves the same choices on every load of a round", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, title: `Track ${i}` })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
    const id = await startGame("pop", "choices");
    const first = await (await get(`/play/${id}`)).text();
    const second = await (await get(`/play/${id}`)).text();
    const pick = (body: string) =>
      [...body.matchAll(/name="choice" value="([^"]*)"/g)].map((m) => m[1]);
    expect(pick(first)).toHaveLength(4);
    expect(pick(first)).toEqual(pick(second));
  });

  it("keeps the right answer out of the round response", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({
        id: i,
        title: i === 1 ? "Secret Song" : `Other ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Secret Song" : `Other ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "typed");
    const body = await (await get(`/play/${id}`)).text();
    const served = (await getGame(testEnv() as never, id))!;
    const answer = served.candidates[served.current!.index];
    expect(body).not.toContain(answer.title);
    expect(body).toContain(`${answer.deezerId}.mp3`);
  });

  it("advances a round through the form endpoints the in-page script posts to", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
    const id = await startGame("pop", "choices");
    const question = await (await get(`/play/${id}`)).text();
    expect(question).toContain('id="game"');
    expect(question).toContain('data-phase="question"');
    // solo.js follows each POST's redirect and swaps #game into the page, so
    // the contract is: a 303 to /play/:id whose GET body carries that region.
    const answered = await answer(id, { choice: "Song 0" });
    expect(answered.status).toBe(303);
    const reveal = await (await get(answered.headers.get("location")!)).text();
    expect(reveal).toContain('id="game"');
    expect(reveal).toContain('data-phase="reveal"');
    const advanced = await next(id);
    expect(advanced.status).toBe(303);
    const nextRound = await (
      await get(advanced.headers.get("location")!)
    ).text();
    expect(nextRound).toContain('id="game"');
    expect(nextRound).toContain('data-phase="question"');
    expect(nextRound).toContain('action="/play/' + id + '/answer"');
  });

  it("updates the header's round and score after an answer", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
    const id = await startGame("pop", "choices");
    const question = await (await get(`/play/${id}`)).text();
    expect(question).toContain(`aria-label="Round 1 of ${roundsPerGame}"`);
    expect(question).toContain('<span class="game-score-n">0</span>');
    const game = (await getGame(testEnv() as never, id))!;
    const answerTitle = game.candidates[game.current!.index].title;
    game.current!.servedAt = Date.now() - 5_000;
    await putGame(testEnv() as never, game);
    const answered = await answer(id, { choice: answerTitle });
    const reveal = await (await get(answered.headers.get("location")!)).text();
    const total = (await getGame(testEnv() as never, id))!.total;
    expect(total).toBeGreaterThan(0);
    expect(reveal).toContain(
      `<span class="game-score-n">${total.toLocaleString("en-US")}</span>`,
    );
    const advanced = await next(id);
    const nextRound = await (
      await get(advanced.headers.get("location")!)
    ).text();
    expect(nextRound).toContain(`aria-label="Round 2 of ${roundsPerGame}"`);
    expect(nextRound).toContain(
      `<span class="game-score-n">${total.toLocaleString("en-US")}</span>`,
    );
  });

  it("scores by the time the server measured, not a client value", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({
        id: i,
        title: i === 1 ? "Known Song" : `Filler ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Known Song" : `Filler ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    const answerTitle = game.candidates[game.current!.index].title;
    game.current!.servedAt = Date.now() - 5_000;
    await putGame(testEnv() as never, game);
    const response = await answer(id, { choice: answerTitle });
    expect(response.status).toBe(303);
    const done = (await getGame(testEnv() as never, id))!;
    expect(done.results[0].correct).toBe(true);
    expect(done.results[0].score).toBeGreaterThan(640);
    expect(done.results[0].score).toBeLessThanOrEqual(700);
    const timed = (await getGame(testEnv() as never, id))!;
    expect(timed.total).toBe(done.results[0].score);
  });

  it("accepts lenient typed answers and rejects a different title", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({
        id: i,
        title: "Café del Mar",
        artist: `Artist ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) =>
          deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "Café del Mar"),
      ],
    ]);
    const id = await startGame("pop", "typed");
    await get(`/play/${id}`);
    await answer(id, { answer: "cafe del mar (live)" });
    let game = (await getGame(testEnv() as never, id))!;
    expect(game.results[0].correct).toBe(true);
    await next(id);
    await get(`/play/${id}`);
    await answer(id, { answer: "Something Else Entirely" });
    game = (await getGame(testEnv() as never, id))!;
    expect(game.results.at(-1)!.correct).toBe(false);
    expect(game.results.at(-1)!.score).toBe(0);
  });

  it("persists done when a guest's solo game ends", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      Array.from({ length: 4 }, (_, i) => ({
        id: i + 1,
        title: `Song ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
    const id = await startGame("pop", "choices");
    // Four candidates is enough to reach done by exhaustion: all but the
    // last round go through the game module; the last one goes through the
    // routes so the finish still crosses answer → next → done over HTTP.
    const game = (await getGame(testEnv() as never, id))!;
    for (let round = 0; round < 3; round += 1) {
      await serveRound(testEnv() as never, game, Date.now());
      await answerRound(
        testEnv() as never,
        game,
        { choice: "Wrong" },
        Date.now(),
      );
      advance(game);
      await putGame(testEnv() as never, game);
    }
    await get(`/play/${id}`);
    await answer(id, { choice: "Wrong" });
    await next(id);
    const stored = (await getGame(testEnv() as never, id))!;
    expect(stored.phase).toBe("done");
    const done = await get(`/play/${id}`);
    expect(await done.text()).toContain("Game over");
  });

  it("refuses answers once a game is finished or gone", async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({
        id: i,
        title: i === 1 ? "Only Song" : `Rest ${i}`,
      })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, id === 1 ? "Only Song" : `Rest ${id}`);
        },
      ],
    ]);
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    game.phase = "done";
    game.current = null;
    game.results.push({
      trackKey: "dz:1",
      title: "Only Song",
      artist: "Artist",
      cover: null,
      link: null,
      answer: "Only Song",
      correct: true,
      timedOut: false,
      score: 900,
      elapsedMs: 0,
      choices: [],
    });
    await putGame(testEnv() as never, game);
    const refused = await answer(id, { choice: "Only Song" });
    expect(refused.status).toBe(303);
    const after = (await getGame(testEnv() as never, id))!;
    expect(after.results.length).toBe(1);
    const missing = await answer("no-such-game", { choice: "x" });
    expect(missing.status).toBe(404);
  });

  it("serves an Apple chart track through a Deezer search preview", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("rss.marketingtools.apple.com"))
          return Response.json({
            feed: { results: [1, 2, 3, 4, 5].map(appleChartEntry) },
          });
        if (url.includes("api.deezer.com/search"))
          return Response.json({
            data: [
              { ...deezerTrack(42, "x"), artist: { name: "Chart Artist" } },
            ],
          });
        return new Response("not found", { status: 404 });
      }),
    );
    const id = await startGame("top-50-japan", "typed");
    const response = await get(`/play/${id}`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("https://cdn.example/42.mp3");
    expect(calls.some((url) => url.includes("itunes.apple.com"))).toBe(false);
  });

  it("shows the category-unavailable page when no candidate resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("rss.marketingtools.apple.com"))
          return Response.json({
            feed: { results: [1, 2, 3, 4, 5].map(appleChartEntry) },
          });
        return new Response("upstream down", { status: 502 });
      }),
    );
    const id = await startGame("top-50-japan", "typed");
    const response = await get(`/play/${id}`);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("Top 50 Japan is not available right now");
    expect(body).not.toContain("Game over");
  });
});

describe("the round clock", () => {
  const chart = async () => {
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/\d+/,
        (url: string) => deezerTrack(Number(/track\/(\d+)/.exec(url)![1]), "x"),
      ],
    ]);
  };

  it("starts the clock when the client reports the clip playing", async () => {
    await chart();
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const before = Date.now();
    const response = await playing(id);
    expect(response.status).toBe(200);
    const { remaining } = (await response.json()) as { remaining: number };
    const game = (await getGame(testEnv() as never, id))!;
    const started = game.current!.startedAt!;
    expect(started).toBeGreaterThanOrEqual(before);
    expect(started).toBeLessThanOrEqual(Date.now());
    expect(remaining).toBeGreaterThan(14_000);
    expect(remaining).toBeLessThanOrEqual(15_000);
    // Scoring measures from the report, not the serve: wind the clock back
    // two seconds and a right answer scores as two seconds in.
    game.current!.startedAt = Date.now() - 2_000;
    await putGame(testEnv() as never, game);
    const title = game.candidates[game.current!.index].title;
    await answer(id, { choice: title });
    const done = (await getGame(testEnv() as never, id))!;
    expect(done.results[0].score).toBeGreaterThan(840);
    expect(done.results[0].score).toBeLessThanOrEqual(910);
  });

  it("caps the wait at five seconds after the round was served", async () => {
    await chart();
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    game.current!.servedAt = Date.now() - 8_000;
    await putGame(testEnv() as never, game);
    await playing(id);
    const after = (await getGame(testEnv() as never, id))!;
    expect(after.current!.startedAt).toBe(game.current!.servedAt + 5_000);
  });

  it("refuses a report before the round is served and after it ends", async () => {
    await chart();
    const id = await startGame("pop", "choices");
    const early = await playing(id);
    expect(early.status).toBe(409);
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    const title = game.candidates[game.current!.index].title;
    await answer(id, { choice: title });
    const late = await playing(id);
    expect(late.status).toBe(409);
  });

  it("does not reset the clock on a reload", async () => {
    await chart();
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    await playing(id);
    const first = (await getGame(testEnv() as never, id))!;
    const served = first.current!.servedAt;
    const started = first.current!.startedAt;
    await get(`/play/${id}`);
    await playing(id);
    const after = (await getGame(testEnv() as never, id))!;
    expect(after.current!.servedAt).toBe(served);
    expect(after.current!.startedAt).toBe(started);
  });

  it("keeps a round /next served while prepare was still resolving", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let trackCalls = 0;
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (/api\.deezer\.com\/track\/\d+/.test(url)) {
          trackCalls += 1;
          // The second lookup is prepare's (the first served round 1);
          // it hangs so /next's own resolve finishes first.
          if (trackCalls === 2) await gate;
          const n = Number(/track\/(\d+)/.exec(url)![1]);
          return new Response(JSON.stringify(deezerTrack(n, "x")), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    const id = await startGame("pop", "choices");
    await get(`/play/${id}`);
    const game = (await getGame(testEnv() as never, id))!;
    const title = game.candidates[game.current!.index].title;
    await answer(id, { choice: title });
    const revealed = (await getGame(testEnv() as never, id))!;
    expect(revealed.phase).toBe("reveal");
    const prep = prepareNext(testEnv() as never, revealed);
    await vi.waitFor(() => expect(trackCalls).toBe(2));
    const served = await next(id);
    expect(served.status).toBe(303);
    // The GET serves the round while prepare's lookup is still held.
    await get(`/play/${id}`);
    release();
    expect(await prep).toBeNull();
    const after = (await getGame(testEnv() as never, id))!;
    expect(after.phase).toBe("question");
    expect(after.current).not.toBeNull();
    expect(after.served).toBe(2);
  });
});

describe("typed matching", () => {
  it.each([
    ["Cafe Del Mar", "Café del Mar", true],
    ["cafe del mar (live)", "Café del Mar", true],
    ["Weird Fishes", "Weird Fishes / Arpeggi", false],
    ["Otonake", "Otonoke", true],
    ["Blue", "Green", false],
  ])("%s vs %s → %s", (given, title, expected) => {
    expect(matchTyped(given, title)).toBe(expected);
  });

  it("scores linearly and times out at 15 s", () => {
    expect(scoreFor(0)).toBe(1000);
    expect(scoreFor(7_500)).toBe(550);
    expect(scoreFor(15_000)).toBe(0);
    expect(scoreFor(20_000)).toBe(0);
  });
});

describe("preview resolution", () => {
  const game = (candidates: Candidate[]) =>
    buildGame(
      testEnv() as never,
      { slug: "mine", name: "Mine", feed: "mine", ref: null },
      "typed",
      candidates,
    );

  it("lets an ISRC hit win over search", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("isrc:"))
          return Response.json({
            ...deezerTrack(7, "Track"),
            preview: "https://cdn.example/isrc.mp3",
            artist: { name: "Real Artist" },
          });
        return Response.json({ data: [] });
      }),
    );
    const built = await game([
      {
        title: "Track",
        artist: "Real Artist",
        cover: null,
        link: null,
        isrc: "USABC1234567",
      },
    ]);
    const served = await serveRound(testEnv() as never, built, Date.now());
    expect(served.preview?.url).toBe("https://cdn.example/isrc.mp3");
    expect(calls.some((url) => url.includes("isrc:USABC1234567"))).toBe(true);
    expect(calls.some((url) => url.includes("/search?"))).toBe(false);
  });

  it("rejects a search hit by another artist and skips the track", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/search/,
        {
          data: [{ ...deezerTrack(9, "Track"), artist: { name: "Remixer" } }],
        },
      ],
    ]);
    const built = await game([
      { title: "Track", artist: "Wanted Artist", cover: null, link: null },
    ]);
    const served = await serveRound(testEnv() as never, built, Date.now());
    expect(served.preview).toBeNull();
    expect(built.phase).toBe("done");
  });

  const quotaBody = {
    error: {
      type: "Exception",
      message: "Quota limit exceeded",
      code: 4,
    },
  };

  it.each([
    {
      name: "track lookup",
      candidate: {
        title: "Track",
        artist: "Artist",
        cover: null,
        link: null,
        deezerId: 7,
      },
      url: "api.deezer.com/track/7",
    },
    {
      name: "isrc lookup",
      candidate: {
        title: "Track",
        artist: "Artist",
        cover: null,
        link: null,
        isrc: "USABC1234567",
      },
      url: "api.deezer.com/track/isrc:",
    },
    {
      name: "search",
      candidate: {
        title: "Track",
        artist: "Artist",
        cover: null,
        link: null,
      },
      url: "api.deezer.com/search",
    },
  ])(
    "holds the round unserved when the $name answers quota",
    async ({ candidate, url }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          Response.json(String(input).includes(url) ? quotaBody : { data: [] }),
        ),
      );
      const built = await game([candidate]);
      const served = await serveRound(testEnv() as never, built, Date.now());
      expect(served.quota).toBe(true);
      const stored = (await getGame(testEnv() as never, built.id))!;
      expect(stored.next).toBe(0);
      expect(stored.current).toBeNull();
      expect(stored.served).toBe(0);
    },
  );

  it("serves the held candidate on a retry after the quota lifts", async () => {
    let limited = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/track/"))
          return Response.json(limited ? quotaBody : deezerTrack(7, "x"));
        return Response.json({ data: [] });
      }),
    );
    const built = await game([
      {
        title: "Kept Song",
        artist: "Artist",
        cover: null,
        link: null,
        deezerId: 7,
      },
    ]);
    const first = await get(`/play/${built.id}`);
    expect(first.status).toBe(503);
    const body = await first.text();
    expect(body).toContain("The clip service is busy");
    expect(body).toContain(`/play/${built.id}`);
    const held = (await getGame(testEnv() as never, built.id))!;
    expect(held.next).toBe(0);
    expect(held.current).toBeNull();
    expect(held.served).toBe(0);
    limited = false;
    const retry = await get(`/play/${built.id}`);
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("https://cdn.example/7.mp3");
    const served = (await getGame(testEnv() as never, built.id))!;
    expect(served.candidates[served.current!.index].title).toBe("Kept Song");
  });

  it("still skips a candidate whose Deezer error is not a quota", async () => {
    stubFetch([
      [
        /api\.deezer\.com\/track\/(\d+)/,
        (url: string) =>
          /track\/(\d+)/.exec(url)![1] === "1"
            ? { error: { type: "Exception", message: "no data", code: 800 } }
            : deezerTrack(2, "x"),
      ],
    ]);
    const built = await game([
      { title: "Gone", artist: "Artist", cover: null, link: null, deezerId: 1 },
      {
        title: "Other Song",
        artist: "Artist",
        cover: null,
        link: null,
        deezerId: 2,
      },
    ]);
    const served = await serveRound(testEnv() as never, built, Date.now());
    expect(served.quota).toBe(false);
    expect(served.preview?.url).toBe("https://cdn.example/2.mp3");
  });

  it("serves every round when early shuffled candidates cannot resolve", async () => {
    const built = await game(
      Array.from({ length: 30 }, (_, i) => ({
        title: `Track ${i}`,
        artist: "Artist",
        cover: null,
        link: null,
        deezerId: 500 + i,
      })),
    );
    const dead = new Set(
      built.candidates.slice(0, 15).map((candidate) => candidate.deezerId),
    );
    stubFetch([
      [
        /api\.deezer\.com\/track\/(\d+)/,
        (url: string) => {
          const id = Number(/track\/(\d+)/.exec(url)![1]);
          return deezerTrack(id, "x", !dead.has(id));
        },
      ],
    ]);
    for (let round = 0; round < roundsPerGame; round += 1) {
      const served = await serveRound(testEnv() as never, built, Date.now());
      expect(served.preview).not.toBeNull();
      await answerRound(
        testEnv() as never,
        built,
        { typed: "wrong" },
        Date.now(),
      );
      advance(built);
    }
    expect(built.results).toHaveLength(roundsPerGame);
    expect(built.phase).toBe("done");
  });
});
