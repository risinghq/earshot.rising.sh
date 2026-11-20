import {
  applyD1Migrations,
  env,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import { seedCatalog } from "./catalog";
import type { Room } from "../src/play/room";
import { readCategoryBoard, recordResults } from "../src/play/results";

const origin = "https://music.rising.sh";
const testEnv = () => ({ DB: env.DB, CACHE: env.CACHE, ROOMS: env.ROOMS });

const deezerTrack = (id: number, title: string, preview = true) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: preview ? `https://cdn.example/${id}.mp3` : "",
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

const quotaBody = {
  error: { type: "Exception", message: "Quota limit exceeded", code: 4 },
};

async function stubChart(titles: string[], previewOf = (_id: number) => true) {
  await seedCatalog(
    env.DB,
    "pop",
    titles.map((title, i) => ({ id: 100 + i, title })),
  );
  await seedCatalog(
    env.DB,
    "rock",
    titles.map((title, i) => ({ id: 200 + i, title })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const id = /track\/(\d+)/.exec(url)?.[1];
      if (id)
        return Response.json(
          deezerTrack(Number(id), "x", previewOf(Number(id))),
        );
      return Response.json({ data: [] });
    }),
  );
}

async function createRoom(mode = "normal") {
  const response = await app.fetch(
    new Request(`${origin}/play/room`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams({ category: "pop", mode }).toString(),
    }),
    testEnv() as never,
  );
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!, origin);
  const code = /room\/(\w+)/.exec(location.pathname)![1];
  return { code, key: location.searchParams.get("k")! };
}

const stubFor = (code: string) =>
  env.ROOMS.get(env.ROOMS.idFromName(code)) as DurableObjectStub<Room>;

interface Client {
  ws: WebSocket;
  inbox: Array<Record<string, unknown>>;
  send: (value: unknown) => void;
  close: () => void;
}

async function connect(code: string): Promise<Client> {
  const response = await app.fetch(
    new Request(`${origin}/play/room/${code}/ws`, {
      headers: { upgrade: "websocket" },
    }),
    testEnv() as never,
  );
  const ws = response.webSocket!;
  ws.accept();
  const inbox: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(String(event.data)));
  });
  return {
    ws,
    inbox,
    send: (value) => ws.send(JSON.stringify(value)),
    close: () => ws.close(),
  };
}

async function waitFor(
  client: Client,
  match: (message: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = [...client.inbox].reverse().find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no matching message; got ${JSON.stringify(client.inbox)}`);
}

const isType = (type: string) => (m: Record<string, unknown>) =>
  m.type === type;
const inPhase = (phase: string) => (m: Record<string, unknown>) =>
  m.type === "state" && m.phase === phase;

async function join(client: Client, name: string | undefined, token?: string) {
  client.send({ type: "join", name, token });
  return waitFor(client, isType("joined"));
}

const stored = (code: string) =>
  runInDurableObject(stubFor(code), (_room, state) =>
    state.storage.get("room"),
  ) as Promise<Record<string, never>>;

const call = <T>(code: string, fn: (room: Room) => T) =>
  runInDurableObject(stubFor(code), (room) => fn(room));

// Plays a whole game inside one visit to the object: each round every
// seated player answers the served track, then the reveal deadline is
// ticked past. A null round means the quota hold; its retry deadline is
// the tick that moves it. Nothing waits on a real alarm.
const playGame = (code: string) =>
  runInDurableObject(stubFor(code), async (room, state) => {
    const read = () =>
      state.storage.get("room") as Promise<Record<string, never>>;
    for (let round = 0; round < 10; round += 1) {
      const s = await read();
      if (s.phase === "done") return;
      const current = s.round as {
        index: number;
        startedAt: number;
      } | null;
      if (current === null) {
        const hold = (s.retryAt ??
          (s.reveal as { until: number } | null)?.until ??
          0) as number;
        await room.tick(hold + 1);
        round -= 1;
        continue;
      }
      const title = (s.candidates as { title: string }[])[current.index].title;
      for (const player of s.players as { id: string }[])
        await room.answer(player.id, title, current.startedAt + 1_000);
      // A tick past the round end also clears the reveal that followed.
      await room.tick(current.startedAt + 60_000);
    }
  });

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
}, 20000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rooms", () => {
  it("scores the faster right answer more", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    const joined = await join(ann, "Ann", key);
    expect(joined.creator).toBe(true);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    await waitFor(bob, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string; name: string }[];
    const pid = (name: string) => players.find((p) => p.name === name)!.id;
    await call(code, async (room) => {
      await room.answer(pid("Ann"), title, started.startedAt + 2_000);
      await room.answer(pid("Bob"), title, started.startedAt + 9_000);
    });
    const after = await stored(code);
    const reveal = after.reveal as {
      results: { name: string; score: number; correct: boolean }[];
    };
    const annScore = reveal.results.find((r) => r.name === "Ann")!.score;
    const bobScore = reveal.results.find((r) => r.name === "Bob")!.score;
    expect(annScore).toBeGreaterThan(bobScore);
    expect(bobScore).toBeGreaterThan(0);
    ann.close();
    bob.close();
  });

  it("writes one outcome row per answering player", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as {
      index: number;
      startedAt: number;
    };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string }[];
    await call(code, async (room) => {
      for (const player of players)
        await room.answer(player.id, title, started.startedAt + 1_000);
    });
    const rows = await env.DB.prepare(
      `SELECT player_key, track_key, category, kind, mode
       FROM round_outcomes`,
    ).all<{
      player_key: string;
      track_key: string;
      category: string;
      kind: string;
      mode: string;
    }>();
    expect(rows.results.length).toBe(2);
    for (const row of rows.results)
      expect(row).toMatchObject({
        category: "pop",
        kind: "room",
        mode: "normal",
      });
    ann.close();
    bob.close();
  });

  it("scores a wrong answer 0", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("loading"));
    const room = await stored(code);
    const pid = (room.players as { id: string }[])[0].id;
    const started = room.round as { startedAt: number };
    await call(code, (room) =>
      room.answer(pid, "Not the title", started.startedAt + 1_000),
    );
    const after = await stored(code);
    const reveal = after.reveal as { results: { score: number }[] };
    expect(reveal.results[0].score).toBe(0);
    ann.close();
  });

  it("closes the round early once everyone answered", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as {
      index: number;
      startedAt: number;
      endsAt: number;
    };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string; name: string }[];
    await call(code, async (room) => {
      for (const player of players)
        await room.answer(player.id, title, started.startedAt + 1_000);
    });
    const after = await stored(code);
    expect(after.phase).toBe("reveal");
    const reveal = after.reveal as { until: number };
    expect(reveal.until).toBeLessThan(started.endsAt);
    ann.close();
    bob.close();
  });

  it("starts the next game with a fresh streak", async () => {
    // Four candidates is the minimum a room accepts, so the first game ends
    // by exhaustion after four rounds. Nothing waits on an alarm: the clip
    // broadcast marks each serve, and the round's own deadlines are ticked
    // through directly.
    await stubChart(Array.from({ length: 4 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    const withClip = (m: Record<string, unknown>) =>
      m.type === "state" && typeof m.startedAt === "number";
    const playRound = () =>
      runInDurableObject(stubFor(code), async (room, state) => {
        const read = () =>
          state.storage.get("room") as Promise<Record<string, never>>;
        const s = await read();
        const current = s.round as { index: number; startedAt: number };
        const title = (s.candidates as { title: string }[])[current.index]
          .title;
        const pid = (s.players as { id: string }[])[0].id;
        await room.tick(current.startedAt + 1);
        await room.answer(pid, title, current.startedAt + 1_000);
        const until = ((await read()).reveal as { until: number }).until;
        ann.inbox.length = 0;
        await room.tick(until + 1);
      });
    ann.send({ type: "start" });
    for (let round = 0; round < 4; round += 1) {
      await waitFor(ann, withClip);
      await playRound();
    }
    const ended = await stored(code);
    expect(ended.phase).toBe("done");
    expect((ended.players as { streak: number }[])[0].streak).toBe(4);
    ann.inbox.length = 0;
    ann.send({ type: "start" });
    await waitFor(ann, withClip);
    const streak = await runInDurableObject(
      stubFor(code),
      async (room, state) => {
        const s = (await state.storage.get("room")) as Record<string, never>;
        const current = s.round as { index: number; startedAt: number };
        const title = (s.candidates as { title: string }[])[current.index]
          .title;
        const pid = (s.players as { id: string }[])[0].id;
        await room.tick(current.startedAt + 1);
        await room.answer(pid, title, current.startedAt + 1_000);
        return (
          ((await state.storage.get("room")) as Record<string, never>)
            .players as { streak: number }[]
        )[0].streak;
      },
    );
    expect(streak).toBe(1);
    ann.close();
  });

  it("carries the track identity a room report needs", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const pid = (room.players as { id: string }[])[0].id;
    await call(code, (room) =>
      room.answer(pid, title, started.startedAt + 1_000),
    );
    const revealed = (await stored(code)).reveal as {
      track: string;
      title: string;
      artist: string;
    };
    expect(revealed.track).toMatch(/^(dz:|at:)/);
    expect(revealed.title).toBe(title);
    expect(revealed.artist).toBeTruthy();
    const response = await app.fetch(
      new Request(`${origin}/play/report`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        body: new URLSearchParams({
          track: revealed.track,
          title: revealed.title,
          artist: revealed.artist,
          category: "pop",
          reason: "bad_clip",
        }).toString(),
      }),
      env as never,
    );
    expect(response.status).toBe(303);
    const row = await env.DB.prepare(
      "SELECT track_key, title, reason FROM track_reports",
    ).first<{ track_key: string; title: string; reason: string }>();
    expect(row).toMatchObject({
      track_key: revealed.track,
      title,
      reason: "bad_clip",
    });
    ann.close();
  });
  it("reaches the reveal when the outcome write fails", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    await env.DB.prepare("DROP TABLE round_outcomes").run();
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as {
      index: number;
      startedAt: number;
    };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string }[];
    await call(code, async (room) => {
      for (const player of players)
        await room.answer(player.id, title, started.startedAt + 1_000);
    });
    const after = await stored(code);
    expect(after.phase).toBe("reveal");
    expect(after.round).toBeNull();
    ann.close();
    bob.close();
  });
  it("reaches the final standings after 10 rounds", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    // Seats are planted through init and the game begun inside the object;
    // a screen socket still receives the standings broadcast under test.
    const code = "STANDINGS";
    await stubFor(code).fetch("http://room/init", {
      method: "POST",
      body: JSON.stringify({
        code,
        categorySlug: "",
        categoryName: "Pop",
        mode: "normal",
        candidates: Array.from({ length: 10 }, (_, i) => ({
          deezerId: 100 + i,
          title: `Song ${i}`,
          artist: "Artist",
          cover: null,
          link: null,
        })),
        creatorToken: "k",
        players: [{ name: "Ann", token: "a", userId: null }],
      }),
    });
    const screen = await connect(code);
    screen.send({ type: "watch" });
    await call(code, (room) =>
      (room as unknown as { begin(now: number): Promise<void> }).begin(
        Date.now(),
      ),
    );
    await playGame(code);
    const after = await stored(code);
    expect(after.phase).toBe("done");
    const last = (await waitFor(screen, inPhase("done"))) as never as {
      phase: string;
      standings: { name: string; score: number }[];
    };
    expect(last.phase).toBe("done");
    expect(last.standings[0].name).toBe("Ann");
    expect(last.standings[0].score).toBeGreaterThan(9_000);
    screen.close();
  });

  it("refuses a duplicate nickname", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const other = await connect(code);
    await join(ann, "Ann", key);
    other.send({ type: "join", name: "ann" });
    const error = await waitFor(other, isType("error"));
    expect(error.code).toBe("taken");
    ann.close();
    other.close();
  });

  it("keeps the points on a reconnect with the token", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const first = await connect(code);
    const joined = (await join(first, "Ann", key)) as { token: string };
    first.send({ type: "start" });
    await waitFor(first, inPhase("playing"));
    const score = await runInDurableObject(
      stubFor(code),
      async (room, state) => {
        const s = (await state.storage.get("room")) as Record<string, never>;
        const current = s.round as { index: number; startedAt: number };
        const title = (s.candidates as { title: string }[])[current.index]
          .title;
        const pid = (s.players as { id: string }[])[0].id;
        await room.answer(pid, title, current.startedAt + 1_000);
        const after = (await state.storage.get("room")) as Record<
          string,
          never
        >;
        return (after.players as { score: number }[])[0].score;
      },
    );
    expect(score).toBeGreaterThan(0);
    first.close();
    const second = await connect(code);
    const rejoined = (await join(second, undefined, joined.token)) as {
      name: string;
    };
    expect(rejoined.name).toBe("Ann");
    const state = (await waitFor(second, inPhase("reveal"))) as never as {
      players: { name: string; score: number }[];
    };
    expect(state.players.find((p) => p.name === "Ann")!.score).toBe(score);
    second.close();
  });

  it("retries the same candidate after a quota answer", async () => {
    let limited = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/"))
          return Response.json({
            data: [1, 2, 3, 4, 5].map((i) => deezerTrack(i, `Song ${i}`)),
          });
        if (url.includes("api.deezer.com/track/"))
          return Response.json(limited ? quotaBody : deezerTrack(7, "Kept"));
        return Response.json({ data: [] });
      }),
    );
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    const loading = await waitFor(ann, inPhase("loading"));
    expect(loading.round).toBe(1);
    const held = await stored(code);
    expect(held.phase).toBe("loading");
    expect(held.next).toBe(0);
    limited = false;
    const retryAt = (held.retryAt ?? 0) as number;
    await call(code, (room) => room.tick(retryAt + 1));
    const after = await stored(code);
    expect(after.phase).toBe("playing");
    expect(after.next).toBe(1);
    ann.close();
  });

  it("ignores an answer sent before the round starts", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("loading"));
    const room = await stored(code);
    const started = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const pid = (room.players as { id: string }[])[0].id;
    await call(code, (room) =>
      room.answer(pid, title, started.startedAt - 500),
    );
    const after = await stored(code);
    const answers = (after.round as { answers: Record<string, unknown> })
      .answers;
    expect(answers[pid]).toBeUndefined();
    expect((after.players as { score: number }[])[0].score).toBe(0);
    ann.close();
  });

  it("stamps the round start after the clip resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/"))
          return Response.json({
            data: [1, 2, 3, 4, 5].map((i) => deezerTrack(i, `Song ${i}`)),
          });
        if (url.includes("api.deezer.com/track/")) {
          await new Promise((resolve) => setTimeout(resolve, 1600));
          return Response.json(deezerTrack(7, "Slow"));
        }
        return Response.json({ data: [] });
      }),
    );
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    const playing = (await waitFor(ann, inPhase("playing"), 10_000)) as {
      now: number;
      startedAt: number;
    };
    expect(playing.startedAt).toBeGreaterThan(playing.now);
    ann.close();
  });

  it("keeps the quota retry in the future after a slow lookup", async () => {
    // The lookup is slow enough that a retryAt stamped at request time
    // would be provably earlier than one stamped at the response.
    let requestedAt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/"))
          return Response.json({
            data: [1, 2, 3, 4, 5].map((i) => deezerTrack(i, `Song ${i}`)),
          });
        if (url.includes("api.deezer.com/track/")) {
          requestedAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return Response.json(quotaBody);
        }
        return Response.json({ data: [] });
      }),
    );
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    // The quota hold broadcasts after saving retryAt; the begin broadcast
    // is the first loading state, the hold the second. waitFor can evaluate
    // a buffered message more than once, so count distinct messages.
    const loadingStates = new Set<unknown>();
    await waitFor(ann, (m) => {
      if ((m as { phase?: string }).phase === "loading") loadingStates.add(m);
      return loadingStates.size >= 2;
    });
    const held = await stored(code);
    expect(held.phase).toBe("loading");
    expect(held.retryAt as number).toBeGreaterThan(requestedAt + 2_500);
    expect(held.retryAt as number).toBeGreaterThan(Date.now());
  });

  it("does not let a re-resolved clip overwrite the next round", async () => {
    let slowId = -1;
    // The re-resolution is held until round 2 is served, so the race is
    // forced: no real-clock delay decides whether it lands late.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowServed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/"))
          return Response.json({
            data: [1, 2, 3, 4, 5].map((i) => deezerTrack(i, `Song ${i}`)),
          });
        const id = /track\/(\d+)/.exec(url)?.[1];
        if (id) {
          if (id === String(slowId)) {
            await gate;
            slowServed = true;
          }
          return Response.json(deezerTrack(Number(id), "x"));
        }
        return Response.json({ data: [] });
      }),
    );
    await seedCatalog(
      env.DB,
      "pop",
      [1, 2, 3, 4, 5].map((i) => ({ id: i, title: `Song ${i}` })),
    );
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const first = room.round as { index: number; endsAt: number };
    slowId = (room.candidates as { deezerId?: number }[])[first.index]
      .deezerId!;
    await call(code, (room) => {
      const exposed = room as unknown as {
        clip: string | null;
        ensureClip(): void;
      };
      exposed.clip = null;
      exposed.ensureClip();
    });
    await call(code, (room) => room.tick(first.endsAt + 1));
    const revealed = await stored(code);
    await call(code, (room) =>
      room.tick((revealed.reveal as { until: number }).until + 1),
    );
    const round2 = ((await stored(code)).round as { index: number }).index;
    release();
    await vi.waitFor(() => expect(slowServed).toBe(true));
    const after = await call(code, async (room) => {
      // The late lookup's continuation runs inside the object; yield once so
      // it has landed before the clip is read.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return (room as unknown as { clip: string | null }).clip;
    });
    const expected = (
      (await stored(code)).candidates as { deezerId?: number }[]
    )[round2].deezerId;
    expect(after).toBe(`https://cdn.example/${expected}.mp3`);
    ann.close();
  });

  it("closes the round when the last unanswered player leaves", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const started = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const pid = (room.players as { id: string; name: string }[]).find(
      (p) => p.name === "Ann",
    )!.id;
    await call(code, (room) =>
      room.answer(pid, title, started.startedAt + 1_000),
    );
    bob.close();
    const reveal = await waitFor(ann, inPhase("reveal"));
    expect(reveal.type).toBe("state");
    ann.close();
  });

  it("starts the round once every connected device reports the clip loaded", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    const first = (await waitFor(ann, inPhase("playing"))) as {
      startedAt: number;
    };
    const provisional = first.startedAt;
    ann.send({ type: "loaded" });
    bob.send({ type: "loaded" });
    const moved = (await waitFor(
      ann,
      (m) =>
        m.type === "state" &&
        m.phase === "playing" &&
        (m.startedAt as number) < provisional,
    )) as { startedAt: number; endsAt: number };
    expect(moved.endsAt - moved.startedAt).toBe(15_000);
    ann.close();
    bob.close();
  });

  it("keeps the four-second wait when no device reports", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    const room = await stored(code);
    const round = room.round as { servedAt: number; startedAt: number };
    expect(round.startedAt).toBe(round.servedAt + 5_500);
    ann.close();
  });

  it("lets a screen watch without taking a seat", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const screen = await connect(code);
    screen.send({ type: "watch" });
    const state = await waitFor(screen, inPhase("lobby"));
    expect(state.watch).toBe(true);
    expect((state.you as { name: string }).name).toBe("");
    expect(screen.inbox.some(isType("joined"))).toBe(false);
    expect((await stored(code)).players).toHaveLength(0);
    const ann = await connect(code);
    await join(ann, "Ann", key);
    expect((await stored(code)).players).toHaveLength(1);
    const roster = (await waitFor(
      screen,
      (m) =>
        m.type === "state" && (m.players as { name: string }[]).length === 1,
    )) as { players: { name: string }[] };
    expect(roster.players[0].name).toBe("Ann");
    ann.close();
    screen.close();
  });

  it("keeps the clip on the screen while the phones get a screen flag", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    const screen = await connect(code);
    screen.send({ type: "watch" });
    const flagged = (await waitFor(
      ann,
      (m) => m.type === "state" && m.screen === true,
    )) as { screen: boolean };
    expect(flagged.screen).toBe(true);
    ann.send({ type: "start" });
    const phone = (await waitFor(ann, inPhase("playing"))) as {
      clip?: string;
      screen?: boolean;
      choices?: string[];
    };
    expect(phone.clip).toBeUndefined();
    expect(phone.screen).toBe(true);
    expect(phone.choices).toHaveLength(4);
    const tv = (await waitFor(screen, inPhase("playing"))) as {
      clip?: string;
    };
    expect(tv.clip).toMatch(/^https:\/\/cdn\.example\//);
    ann.close();
    screen.close();
  });

  it("does not let a screen fill a seat, so a match still waits alone", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const code = "MATCHX";
    const init = await stubFor(code).fetch(
      new Request("https://room/init", {
        method: "POST",
        body: JSON.stringify({
          code,
          kind: "match",
          categorySlug: "pop",
          categoryName: "Pop",
          mode: "normal",
          candidates: Array.from({ length: 10 }, (_, i) => ({
            title: `Song ${i}`,
            artist: "Artist",
            cover: null,
            link: null,
            deezerId: 100 + i,
          })),
          creatorToken: "",
          players: [
            { name: "Ann", token: "tok-a", userId: null },
            { name: "Bob", token: "tok-b", userId: null },
          ],
        }),
      }),
    );
    expect(init.ok).toBe(true);
    const screen = await connect(code);
    screen.send({ type: "watch" });
    await waitFor(screen, inPhase("lobby"));
    const ann = await connect(code);
    await join(ann, undefined, "tok-a");
    // One seated player and a screen is still only one player: the match
    // does not start until every seat holds a live socket.
    expect((await stored(code)).phase).toBe("lobby");
    const bob = await connect(code);
    await join(bob, undefined, "tok-b");
    await waitFor(bob, inPhase("loading"));
    ann.close();
    bob.close();
    screen.close();
  });

  it("adds the category board to the final standings", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (1, 1, 'pro', 1, 1)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO game_results
       (id, user_id, finished_at, category, kind, score, rank, players)
       VALUES ('t:1:pop', 1, ?1, 'pop', 'solo', 7000, 1, 1)`,
    )
      .bind(now - 60)
      .run();
    await stubChart(Array.from({ length: 4 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    const screen = await connect(code);
    screen.send({ type: "watch" });
    await waitFor(screen, inPhase("lobby"));
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("playing"));
    await playGame(code);
    const done = (await waitFor(ann, inPhase("done"))) as {
      phase: string;
      board: { name: string; score: number }[];
    };
    expect(done.phase).toBe("done");
    expect(done.board).toEqual([{ name: "pro", score: 7000 }]);
    const screenDone = (await waitFor(screen, inPhase("done"))) as {
      board: { name: string; score: number }[];
    };
    expect(screenDone.board).toEqual([{ name: "pro", score: 7000 }]);
    ann.close();
    screen.close();
  });

  it("refreshes a cached category board when results are written", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (1, 1, 'pro', 1, 1)",
    ).run();
    // The board was read right before the game: its cache holds a stale,
    // empty copy that must not survive the result write.
    await env.CACHE.put("play:catboard:pop", JSON.stringify([]));
    await recordResults(testEnv() as never, [
      {
        id: "t:stale:pop",
        userId: 1,
        finishedAt: now,
        category: "pop",
        kind: "room",
        score: 5000,
        rank: 1,
        players: 2,
      },
    ]);
    expect(await readCategoryBoard(testEnv() as never, "pop")).toEqual([
      { name: "pro", score: 5000 },
    ]);
  });

  it("deletes an idle room even with a socket open", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    const room = await stored(code);
    const lastActive = room.lastActive as number;
    const tickAt = lastActive + 3_600_001;
    await call(code, (room) => room.tick(tickAt));
    const cleared = await runInDurableObject(stubFor(code), async (_r, s) => ({
      state: await s.storage.get("room"),
      alarm: await s.storage.getAlarm(),
    }));
    expect(cleared.state).toBeUndefined();
    expect(cleared.alarm === null || cleared.alarm > tickAt).toBe(true);
    ann.close();
  });

  it("announces the sheet verdict in a live region", async () => {
    await stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code } = await createRoom();
    let response = await app.fetch(
      new Request(`${origin}/play/room/${code}`),
      testEnv() as never,
    );
    if (response.status === 301 || response.status === 302) {
      response = await app.fetch(
        new Request(response.headers.get("location")!, {
          headers: { cookie: response.headers.get("set-cookie") ?? "" },
        }),
        testEnv() as never,
      );
    }
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="sheet-verdict" aria-live="polite"');
  });
});
