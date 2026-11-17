import {
  applyD1Migrations,
  env,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";
import type { Matchmaker } from "../src/play/match";
import type { Room } from "../src/play/room";

const origin = "https://earshot.rising.sh";
const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  ROOMS: env.ROOMS,
  MATCHMAKER: env.MATCHMAKER,
});

const deezerTrack = (id: number, title: string) => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: `https://cdn.example/${id}.mp3`,
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

function stubChart(titles: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deezer.com/chart/"))
        return Response.json({
          data: titles.map((title, i) => deezerTrack(100 + i, title)),
        });
      const id = /track\/(\d+)/.exec(url)?.[1];
      if (id) return Response.json(deezerTrack(Number(id), "x"));
      return Response.json({ data: [] });
    }),
  );
}

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

let userSeq = 0;
async function signIn(name: string, isPublic = 1) {
  userSeq += 1;
  const id = 100 + userSeq;
  const token = `sess_${id}_${"s".repeat(30)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(id, id, name, isPublic, now),
    env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
    ).bind(await sha256(token), id, now + 86400),
  ]);
  return { id, token };
}

interface Client {
  ws: WebSocket;
  inbox: Array<Record<string, unknown>>;
  send: (value: unknown) => void;
  close: () => void;
}

async function waitFor(
  client: Client,
  match: (message: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
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

async function queue(slug: string, cookie?: string): Promise<Client> {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (cookie) headers.cookie = cookie;
  const response = await app.fetch(
    new Request(`${origin}/play/match/${slug}/ws`, { headers }),
    testEnv() as never,
  );
  expect(response.status).toBe(101);
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

async function joinRoom(code: string, token: string, cookie?: string) {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (cookie) headers.cookie = cookie;
  const response = await app.fetch(
    new Request(`${origin}/play/room/${code}/ws`, { headers }),
    testEnv() as never,
  );
  const ws = response.webSocket!;
  ws.accept();
  const inbox: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(String(event.data)));
  });
  const client: Client = {
    ws,
    inbox,
    send: (value) => ws.send(JSON.stringify(value)),
    close: () => ws.close(),
  };
  client.send({ type: "join", token });
  await waitFor(client, isType("joined"));
  return client;
}

const roomStub = (code: string) =>
  env.ROOMS.get(env.ROOMS.idFromName(code)) as DurableObjectStub<Room>;

const stored = (code: string) =>
  runInDurableObject(roomStub(code), (_room, state) =>
    state.storage.get("room"),
  ) as Promise<Record<string, never>>;

const call = <T>(code: string, fn: (room: Room) => T) =>
  runInDurableObject(roomStub(code), (room) => fn(room));

const resultRows = () =>
  env.DB.prepare("SELECT * FROM game_results ORDER BY user_id")
    .all()
    .then((r) => r.results);

const mmStub = () =>
  env.MATCHMAKER.get(
    env.MATCHMAKER.idFromName("global"),
  ) as DurableObjectStub<Matchmaker>;

// Reads the seats a hibernated Matchmaker keeps on its sockets; polling it
// beats a fixed sleep before a negative assertion.
const queuedCategories = () =>
  runInDurableObject(mmStub(), (mm) =>
    (
      mm as unknown as {
        waiting(): { seat: { category: string; name: string } }[];
      }
    )
      .waiting()
      .map((entry) => entry.seat),
  );

async function untilQueued(count: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seats = await queuedCategories();
    if (seats.length === count) return seats;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("queue did not reach the expected size");
}

async function finishRoom(code: string) {
  for (let round = 0; round < 10; round += 1) {
    const room = await stored(code);
    const current = room.round as {
      index: number;
      startedAt: number;
      endsAt: number;
    } | null;
    if (current === null) {
      const retryAt = (room.retryAt ?? 0) as number;
      await call(code, (r) => r.tick(retryAt + 1));
      round -= 1;
      continue;
    }
    const title = (room.candidates as { title: string }[])[current.index].title;
    const players = room.players as { id: string }[];
    for (const player of players)
      await call(code, (r) =>
        r.answer(player.id, title, current.startedAt + 1_000),
      );
    const reveal = (await stored(code)).reveal as { until: number };
    await call(code, (r) => r.tick(reveal.until + 1));
  }
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("matchmaker", () => {
  it("pairs two players queued in one category into one room", async () => {
    stubChart(Array.from({ length: 12 }, (_, i) => `Song ${i}`));
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    const matchedAnn = (await waitFor(ann, isType("matched"))) as {
      code: string;
      token: string;
    };
    const matchedBob = (await waitFor(bob, isType("matched"))) as {
      code: string;
      token: string;
    };
    expect(matchedAnn.code).toBe(matchedBob.code);
    const room = await stored(matchedAnn.code);
    expect(room.kind).toBe("match");
    expect(room.mode).toBe("choices");
    expect(
      (room.players as { name: string }[]).map((p) => p.name).sort(),
    ).toEqual(["Ann", "Bob"]);
    const ann2 = await joinRoom(matchedAnn.code, matchedAnn.token);
    const bob2 = await joinRoom(matchedBob.code, matchedBob.token);
    const state = (await waitFor(
      ann2,
      (m) =>
        m.type === "state" && (m.phase === "loading" || m.phase === "playing"),
    )) as { phase: string };
    expect(["loading", "playing"]).toContain(state.phase);
    ann.close();
    bob.close();
    ann2.close();
    bob2.close();
  });

  it("does not pair players queued in different categories", async () => {
    stubChart(Array.from({ length: 12 }, (_, i) => `Song ${i}`));
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    const bob = await queue("rock");
    bob.send({ type: "join", name: "Bob" });
    await waitFor(bob, isType("queued"));
    const seats = await untilQueued(2);
    expect(seats.map((seat) => seat.category).sort()).toEqual(["pop", "rock"]);
    expect(ann.inbox.some(isType("matched"))).toBe(false);
    expect(bob.inbox.some(isType("matched"))).toBe(false);
    ann.close();
    bob.close();
  });

  it("leaves the queue when the socket closes", async () => {
    stubChart(Array.from({ length: 12 }, (_, i) => `Song ${i}`));
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    ann.close();
    await untilQueued(0);
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    await waitFor(bob, isType("queued"));
    const cid = await queue("pop");
    cid.send({ type: "join", name: "Cid" });
    const matchedBob = (await waitFor(bob, isType("matched"))) as {
      code: string;
    };
    const matchedCid = (await waitFor(cid, isType("matched"))) as {
      code: string;
    };
    expect(matchedBob.code).toBe(matchedCid.code);
    bob.close();
    cid.close();
  });

  it(
    "writes one row per signed-in player, none for a guest, once",
    { timeout: 20_000 },
    async () => {
      stubChart(Array.from({ length: 30 }, (_, i) => `Song ${i}`));
      const ann = await signIn("ann");
      const queuedA = await queue("pop", `__Host-session=${ann.token}`);
      queuedA.send({ type: "join" });
      await waitFor(queuedA, isType("queued"));
      const guest = await queue("pop");
      guest.send({ type: "join", name: "Guesty" });
      const matched = (await waitFor(queuedA, isType("matched"))) as {
        code: string;
        token: string;
      };
      const matchedGuest = (await waitFor(guest, isType("matched"))) as {
        token: string;
      };
      const code = matched.code;
      const a = await joinRoom(
        code,
        matched.token,
        `__Host-session=${ann.token}`,
      );
      const g = await joinRoom(code, matchedGuest.token);
      await finishRoom(code);
      expect((await stored(code)).phase).toBe("done");
      const rows = await resultRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        user_id: ann.id,
        category: "pop",
        kind: "match",
        rank: 1,
        players: 2,
      });
      expect(rows[0]!.score as number).toBeGreaterThan(9_000);
      // A finish processed again — a late alarm or a repeated write — adds nothing.
      await call(code, (room) =>
        (room as unknown as { recordResults(): Promise<void> }).recordResults(),
      );
      await call(code, (room) => room.tick(Date.now() + 1));
      expect(await resultRows()).toHaveLength(1);
      queuedA.close();
      guest.close();
      a.close();
      g.close();
    },
  );

  it(
    "starts a match with whoever connected and writes players 1",
    { timeout: 20_000 },
    async () => {
      stubChart(Array.from({ length: 30 }, (_, i) => `Song ${i}`));
      const ann = await signIn("ann");
      const queuedA = await queue("pop", `__Host-session=${ann.token}`);
      queuedA.send({ type: "join" });
      await waitFor(queuedA, isType("queued"));
      const guest = await queue("pop");
      guest.send({ type: "join", name: "Guesty" });
      const matched = (await waitFor(queuedA, isType("matched"))) as {
        code: string;
        token: string;
      };
      await waitFor(guest, isType("matched"));
      const code = matched.code;
      // Only one side shows up; the 90-second deadline starts the game.
      const a = await joinRoom(
        code,
        matched.token,
        `__Host-session=${ann.token}`,
      );
      await call(code, (room) => room.tick(Date.now() + 95_000));
      await finishRoom(code);
      expect((await stored(code)).phase).toBe("done");
      const rows = await resultRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: ann.id, kind: "match" });
      expect(rows[0]!.players).toBe(1);
      await env.CACHE.delete("play:board:week");
      const body = await (
        await app.fetch(new Request(`${origin}/play/board`), testEnv() as never)
      ).text();
      expect(body).toContain("0 wins");
      queuedA.close();
      guest.close();
      a.close();
    },
  );

  it("seats a signed-in name up to 39 characters, guests stay at 20", async () => {
    const init = (code: string, players: unknown) =>
      env.ROOMS.get(env.ROOMS.idFromName(code)).fetch("http://room/init", {
        method: "POST",
        body: JSON.stringify({
          code,
          kind: "match",
          categorySlug: "pop",
          categoryName: "Pop",
          mode: "choices",
          candidates: [],
          creatorToken: "",
          players,
        }),
      });
    const ok = await init("SEAT39", [
      { name: "x".repeat(39), token: "t1", userId: 1 },
      { name: "Bob", token: "t2", userId: null },
    ]);
    expect(ok.status).toBe(200);
    const long = await init("SEAT21", [
      { name: "y".repeat(21), token: "t1", userId: null },
      { name: "Bob", token: "t2", userId: null },
    ]);
    expect(long.status).toBe(400);
  });

  it("refuses a stranger joining a match without a seated token", async () => {
    stubChart(Array.from({ length: 12 }, (_, i) => `Song ${i}`));
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    const matched = (await waitFor(ann, isType("matched"))) as {
      code: string;
    };
    const response = await app.fetch(
      new Request(`${origin}/play/room/${matched.code}/ws`, {
        headers: { upgrade: "websocket" },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(101);
    const sneakWs = response.webSocket!;
    sneakWs.accept();
    const sneakInbox: Array<Record<string, unknown>> = [];
    sneakWs.addEventListener("message", (event) => {
      sneakInbox.push(JSON.parse(String(event.data)));
    });
    const sneak: Client = {
      ws: sneakWs,
      inbox: sneakInbox,
      send: (value) => sneakWs.send(JSON.stringify(value)),
      close: () => sneakWs.close(),
    };
    sneak.send({ type: "join", name: "Sneak" });
    await waitFor(sneak, (m) => m.type === "error");
    const room = await stored(matched.code);
    expect((room.players as unknown[]).length).toBe(2);
    ann.close();
    bob.close();
    sneak.close();
  });

  it("pairs the survivor with the next waiter when a partner dies mid-pair", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.deezer.com/chart/")) {
          await gate;
          return Response.json({
            data: Array.from({ length: 12 }, (_, i) =>
              deezerTrack(100 + i, `Song ${i}`),
            ),
          });
        }
        const id = /track\/(\d+)/.exec(url)?.[1];
        if (id) return Response.json(deezerTrack(Number(id), "x"));
        return Response.json({ data: [] });
      }),
    );
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    // Ann and Bob are marked pairing; Cat joins and waits alone.
    const cat = await queue("pop");
    cat.send({ type: "join", name: "Cat" });
    await waitFor(cat, isType("queued"));
    bob.close();
    // The close must reach the object before the fetch resolves.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const open = await runInDurableObject(
        mmStub(),
        (_mm, state) =>
          state.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN)
            .length,
      );
      if (open === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    const matchedAnn = (await waitFor(ann, isType("matched"))) as {
      code: string;
    };
    const matchedCat = (await waitFor(cat, isType("matched"))) as {
      code: string;
    };
    expect(matchedAnn.code).toBe(matchedCat.code);
    ann.close();
    cat.close();
  });

  it("refuses the 'mine' category for random matching", async () => {
    const ann = await signIn("ann");
    const cookie = `__Host-session=${ann.token}`;
    const response = await app.fetch(
      new Request(`${origin}/play/match/mine/ws`, {
        headers: { upgrade: "websocket", cookie },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(404);
    const post = await app.fetch(
      new Request(`${origin}/play/match`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
          origin,
        },
        body: "category=mine",
      }),
      testEnv() as never,
    );
    expect(post.status).toBe(400);
    const page = await app.fetch(
      new Request(`${origin}/play/match/mine`, { headers: { cookie } }),
      testEnv() as never,
    );
    expect(page.status).toBe(404);
  });

  it("asks a second guest with the same nickname to pick another", async () => {
    stubChart(Array.from({ length: 12 }, (_, i) => `Song ${i}`));
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await waitFor(ann, isType("queued"));
    const twin = await queue("pop");
    twin.send({ type: "join", name: "ann" });
    await waitFor(twin, (m) => m.type === "error" && m.code === "taken");
    ann.close();
    twin.close();
  });
});

describe("points board", () => {
  async function addResult(
    userId: number,
    finishedAt: number,
    kind: string,
    score: number,
    rank: number,
    players: number,
  ) {
    await env.DB.prepare(
      `INSERT INTO game_results
       (id, user_id, finished_at, category, kind, score, rank, players)
       VALUES (?1, ?2, ?3, 'pop', ?4, ?5, ?6, ?7)`,
    )
      .bind(
        `t:${userId}:${finishedAt}`,
        userId,
        finishedAt,
        kind,
        score,
        rank,
        players,
      )
      .run();
  }

  const monday = () => {
    const day = Math.floor(Date.now() / 1000 / 86400);
    return (day - ((day + 3) % 7)) * 86400;
  };

  it("totals the week and hides a private profile", async () => {
    const ann = await signIn("ann");
    const bob = await signIn("bob");
    const shy = await signIn("shy", 0);
    const week = monday();
    await addResult(ann.id, week + 100, "match", 5000, 1, 2);
    await addResult(ann.id, week + 200, "solo", 3000, 1, 1);
    await addResult(ann.id, week - 100, "match", 9000, 1, 2);
    await addResult(bob.id, week + 300, "room", 2000, 2, 4);
    await addResult(bob.id, week + 350, "room", 6000, 1, 1);
    await addResult(shy.id, week + 400, "match", 9999, 1, 2);
    await env.CACHE.delete("play:board:week");
    await env.CACHE.delete("play:board:all");
    const response = await app.fetch(
      new Request(`${origin}/play/board`),
      testEnv() as never,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    // Week: ann 5000+3000, bob 2000, shy hidden.
    const annRow = body.indexOf("/u/ann");
    const bobRow = body.indexOf("/u/bob");
    expect(annRow).toBeGreaterThan(-1);
    expect(bobRow).toBeGreaterThan(annRow);
    expect(body).toContain("8000");
    // A one-player room writes points but never a win.
    expect(body).toContain("0 wins");
    expect(body).not.toContain("/u/shy");
    const all = await (
      await app.fetch(
        new Request(`${origin}/play/board?period=all`),
        testEnv() as never,
      )
    ).text();
    expect(all).toContain("17000");
  });
});
