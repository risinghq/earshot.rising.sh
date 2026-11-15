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

  it("reaches the final standings after 10 rounds", async () => {
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
