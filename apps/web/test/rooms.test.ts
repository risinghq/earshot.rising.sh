import {
  applyD1Migrations,
  env,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
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

function stubChart(titles: string[], previewOf = (_id: number) => true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deezer.com/chart/"))
        return Response.json({
          data: titles.map((title, i) => deezerTrack(100 + i, title)),
        });
      const id = /track\/(\d+)/.exec(url)?.[1];
      if (id)
        return Response.json(
          deezerTrack(Number(id), "x", previewOf(Number(id))),
        );
      return Response.json({ data: [] });
    }),
  );
}

async function createRoom(mode = "choices") {
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

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rooms", () => {
  it("scores the faster right answer more", async () => {
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    const joined = await join(ann, "Ann", key);
    expect(joined.creator).toBe(true);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("loading"));
    await waitFor(bob, inPhase("loading"));
    const room = await stored(code);
    const started = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string; name: string }[];
    const pid = (name: string) => players.find((p) => p.name === name)!.id;
    await call(code, (room) =>
      room.answer(pid("Ann"), title, started.startedAt + 2_000),
    );
    await call(code, (room) =>
      room.answer(pid("Bob"), title, started.startedAt + 9_000),
    );
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

  it("scores a wrong answer 0", async () => {
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await join(ann, "Ann", key);
    await join(bob, "Bob");
    ann.send({ type: "start" });
    await waitFor(ann, inPhase("loading"));
    const room = await stored(code);
    const started = room.round as {
      index: number;
      startedAt: number;
      endsAt: number;
    };
    const title = (room.candidates as { title: string }[])[started.index].title;
    const players = room.players as { id: string; name: string }[];
    for (const player of players)
      await call(code, (room) =>
        room.answer(player.id, title, started.startedAt + 1_000),
      );
    const after = await stored(code);
    expect(after.phase).toBe("reveal");
    const reveal = after.reveal as { until: number };
    expect(reveal.until).toBeLessThan(started.endsAt);
    ann.close();
    bob.close();
  });

  it(
    "reaches the final standings after 10 rounds",
    { timeout: 20_000 },
    async () => {
      stubChart(Array.from({ length: 30 }, (_, i) => `Song ${i}`));
      const { code, key } = await createRoom();
      const ann = await connect(code);
      await join(ann, "Ann", key);
      ann.send({ type: "start" });
      await waitFor(ann, inPhase("loading"));
      for (let round = 0; round < 10; round += 1) {
        const room = await stored(code);
        const current = room.round as {
          index: number;
          startedAt: number;
        } | null;
        expect(current).not.toBeNull();
        const title = (room.candidates as { title: string }[])[current!.index]
          .title;
        const pid = (room.players as { id: string }[])[0].id;
        await call(code, (room) =>
          room.answer(pid, title, current!.startedAt + 1_000),
        );
        const reveal = await stored(code);
        const until = (reveal.reveal as { until: number }).until;
        await call(code, (room) => room.tick(until + 1));
      }
      const after = await stored(code);
      expect(after.phase).toBe("done");
      const last = [...ann.inbox]
        .reverse()
        .find((m) => m.type === "state") as never as {
        phase: string;
        standings: { name: string; score: number }[];
      };
      expect(last.phase).toBe("done");
      expect(last.standings[0].name).toBe("Ann");
      expect(last.standings[0].score).toBeGreaterThan(9_000);
      ann.close();
    },
  );

  it("starts the next game with a fresh streak", async () => {
    // Four candidates is the minimum a room accepts, so the first game ends
    // by exhaustion after four rounds. Nothing waits on an alarm: the clip
    // broadcast marks each serve, and the round's own deadlines are ticked
    // through directly.
    stubChart(Array.from({ length: 4 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    const withClip = (m: Record<string, unknown>) =>
      m.type === "state" && typeof m.startedAt === "number";
    const playRound = async () => {
      const room = await stored(code);
      const current = room.round as { index: number; startedAt: number };
      const title = (room.candidates as { title: string }[])[current.index]
        .title;
      const pid = (room.players as { id: string }[])[0].id;
      await call(code, (r) => r.tick(current.startedAt + 1));
      await call(code, (r) => r.answer(pid, title, current.startedAt + 1_000));
      const reveal = await stored(code);
      const until = (reveal.reveal as { until: number }).until;
      ann.inbox.length = 0;
      await call(code, (r) => r.tick(until + 1));
    };
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
    const second = await stored(code);
    const current = second.round as { index: number; startedAt: number };
    const title = (second.candidates as { title: string }[])[current.index]
      .title;
    const pid = (second.players as { id: string }[])[0].id;
    await call(code, (r) => r.tick(current.startedAt + 1));
    await call(code, (r) => r.answer(pid, title, current.startedAt + 1_000));
    const reveal = await stored(code);
    expect((reveal.players as { streak: number }[])[0].streak).toBe(1);
    ann.close();
  });

  it("refuses a duplicate nickname", async () => {
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const { code, key } = await createRoom();
    const first = await connect(code);
    const joined = (await join(first, "Ann", key)) as { token: string };
    first.send({ type: "start" });
    await waitFor(first, inPhase("loading"));
    const room = await stored(code);
    const current = room.round as { index: number; startedAt: number };
    const title = (room.candidates as { title: string }[])[current.index].title;
    const pid = (room.players as { id: string }[])[0].id;
    await call(code, (room) =>
      room.answer(pid, title, current.startedAt + 1_000),
    );
    const score = ((await stored(code)).players as { score: number }[])[0]
      .score;
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/"))
          return Response.json({
            data: [1, 2, 3, 4, 5].map((i) => deezerTrack(i, `Song ${i}`)),
          });
        if (url.includes("api.deezer.com/track/")) {
          await new Promise((resolve) => setTimeout(resolve, 2600));
          return Response.json(quotaBody);
        }
        return Response.json({ data: [] });
      }),
    );
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await join(ann, "Ann", key);
    ann.send({ type: "start" });
    let held = await stored(code);
    const deadline = Date.now() + 10_000;
    while (held.retryAt === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      held = await stored(code);
    }
    expect(held.phase).toBe("loading");
    expect(held.retryAt as number).toBeGreaterThan(Date.now());
    ann.close();
  });

  it("does not let a re-resolved clip overwrite the next round", async () => {
    let slowId = -1;
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
          if (id === String(slowId))
            await new Promise((resolve) => setTimeout(resolve, 1200));
          return Response.json(deezerTrack(Number(id), "x"));
        }
        return Response.json({ data: [] });
      }),
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await call(
      code,
      (room) => (room as unknown as { clip: string | null }).clip,
    );
    const round2 = (await stored(code)).round as { index: number };
    const expected = (
      (await stored(code)).candidates as { deezerId?: number }[]
    )[round2.index].deezerId;
    expect(after).toBe(`https://cdn.example/${expected}.mp3`);
    ann.close();
  });

  it("closes the round when the last unanswered player leaves", async () => {
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
    const code = "MATCHX";
    const init = await stubFor(code).fetch(
      new Request("https://room/init", {
        method: "POST",
        body: JSON.stringify({
          code,
          kind: "match",
          categorySlug: "pop",
          categoryName: "Pop",
          mode: "choices",
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

  it(
    "adds the category board to the final standings",
    { timeout: 20_000 },
    async () => {
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
      stubChart(Array.from({ length: 30 }, (_, i) => `Song ${i}`));
      const { code, key } = await createRoom();
      const ann = await connect(code);
      await join(ann, "Ann", key);
      const screen = await connect(code);
      screen.send({ type: "watch" });
      await waitFor(screen, inPhase("lobby"));
      ann.send({ type: "start" });
      await waitFor(ann, inPhase("loading"));
      for (let round = 0; round < 10; round += 1) {
        const room = await stored(code);
        const current = room.round as {
          index: number;
          startedAt: number;
        } | null;
        const title = (room.candidates as { title: string }[])[current!.index]
          .title;
        const pid = (room.players as { id: string }[])[0].id;
        await call(code, (room) =>
          room.answer(pid, title, current!.startedAt + 1_000),
        );
        const reveal = await stored(code);
        const until = (reveal.reveal as { until: number }).until;
        await call(code, (room) => room.tick(until + 1));
      }
      const done = [...ann.inbox].reverse().find((m) => m.type === "state") as {
        phase: string;
        board: { name: string; score: number }[];
      };
      expect(done.phase).toBe("done");
      expect(done.board).toEqual([{ name: "pro", score: 7000 }]);
      const screenDone = [...screen.inbox]
        .reverse()
        .find((m) => m.type === "state") as {
        board: { name: string; score: number }[];
      };
      expect(screenDone.board).toEqual([{ name: "pro", score: 7000 }]);
      ann.close();
      screen.close();
    },
  );

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
    stubChart(Array.from({ length: 10 }, (_, i) => `Song ${i}`));
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
});
