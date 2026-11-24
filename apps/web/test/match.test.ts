import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Matchmaker } from "../src/play/match";
import { scoreFor } from "../src/play/quiz";
import { matchWaitMs } from "../src/play/room-game";
import {
  connect,
  openSocket,
  playOut,
  roomStub,
  setClock,
  stubChart,
  type Message,
} from "./room-client";

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

const isType = (type: string) => (m: Message) => m.type === type;

const queue = (slug: string, cookie?: string) =>
  openSocket(`/play/match/${slug}/ws`, cookie);

async function joinRoom(code: string, token: string, cookie?: string) {
  const client = await connect(code, cookie);
  await client.join(undefined, token);
  return client;
}

// Two guests queued in pop, paired into one room.
async function pair() {
  const ann = await queue("pop");
  ann.send({ type: "join", name: "Ann" });
  await ann.next(isType("queued"));
  const bob = await queue("pop");
  bob.send({ type: "join", name: "Bob" });
  const matched = (await ann.next(isType("matched"))) as {
    code: string;
    token: string;
  };
  const matchedBob = (await bob.next(isType("matched"))) as {
    code: string;
    token: string;
  };
  return { ann, bob, matched, matchedBob };
}

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

async function untilQueued(count: number) {
  for (let poll = 0; poll < 250; poll += 1) {
    const seats = await queuedCategories();
    if (seats.length === count) return seats;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("queue did not reach the expected size");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("matchmaker", () => {
  it("pairs two players queued in one category into one room", async () => {
    await stubChart(12);
    const { matched, matchedBob } = await pair();
    expect(matched.code).toBe(matchedBob.code);
    const ann = await joinRoom(matched.code, matched.token);
    await joinRoom(matchedBob.code, matchedBob.token);
    const state = (await ann.next(
      (m) =>
        m.type === "state" && (m.phase === "loading" || m.phase === "playing"),
    )) as { kind: string; mode: string; players: { name: string }[] };
    expect(state).toMatchObject({ kind: "match", mode: "normal" });
    expect(state.players.map((p) => p.name).sort()).toEqual(["Ann", "Bob"]);
  });

  it("does not pair players queued in different categories", async () => {
    await stubChart(12);
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await ann.next(isType("queued"));
    const bob = await queue("rock");
    bob.send({ type: "join", name: "Bob" });
    await bob.next(isType("queued"));
    const seats = await untilQueued(2);
    expect(seats.map((seat) => seat.category).sort()).toEqual(["pop", "rock"]);
    expect(ann.inbox.some(isType("matched"))).toBe(false);
    expect(bob.inbox.some(isType("matched"))).toBe(false);
  });

  it("leaves the queue when the socket closes", async () => {
    await stubChart(12);
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await ann.next(isType("queued"));
    ann.close();
    await untilQueued(0);
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    await bob.next(isType("queued"));
    const cid = await queue("pop");
    cid.send({ type: "join", name: "Cid" });
    const matchedBob = (await bob.next(isType("matched"))) as { code: string };
    const matchedCid = (await cid.next(isType("matched"))) as { code: string };
    expect(matchedBob.code).toBe(matchedCid.code);
  });

  it("starts a match with whoever came once the wait is over, and writes their result", async () => {
    await stubChart(4);
    const ann = await signIn("ann");
    const cookie = `__Host-session=${ann.token}`;
    const queuedA = await queue("pop", cookie);
    queuedA.send({ type: "join" });
    await queuedA.next(isType("queued"));
    const guest = await queue("pop");
    guest.send({ type: "join", name: "Guesty" });
    const matched = (await queuedA.next(isType("matched"))) as {
      code: string;
      token: string;
    };
    // Only one side shows up; the wait's deadline starts the game.
    const a = await joinRoom(matched.code, matched.token, cookie);
    await a.state("lobby");
    setClock(Date.now() + matchWaitMs + 1);
    expect(await runDurableObjectAlarm(roomStub(matched.code))).toBe(true);
    await playOut(a, matched.code, 4);
    expect(await resultRows()).toMatchObject([
      {
        user_id: ann.id,
        kind: "match",
        rank: 1,
        players: 1,
        score: 4 * scoreFor(1_000),
      },
    ]);
  });

  it("refuses a stranger joining a match without a seated token", async () => {
    await stubChart(12);
    const { matched } = await pair();
    const sneak = await connect(matched.code);
    sneak.send({ type: "join", name: "Sneak" });
    await sneak.next(isType("error"));
    const ann = await joinRoom(matched.code, matched.token);
    const state = (await ann.next(isType("state"))) as {
      players: { name: string }[];
    };
    expect(state.players.map((p) => p.name).sort()).toEqual(["Ann", "Bob"]);
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
    // The gate holds the live chart fetch inside pair(); playlist-backed
    // categories read D1 and would pair before the sockets can die.
    const ann = await queue("top-50-global");
    ann.send({ type: "join", name: "Ann" });
    await ann.next(isType("queued"));
    const bob = await queue("top-50-global");
    bob.send({ type: "join", name: "Bob" });
    // Ann and Bob are marked pairing; Cat joins and waits alone.
    const cat = await queue("top-50-global");
    cat.send({ type: "join", name: "Cat" });
    await cat.next(isType("queued"));
    bob.close();
    // The close must reach the object before the fetch resolves.
    for (let poll = 0; poll < 250; poll += 1) {
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
    const matchedAnn = (await ann.next(isType("matched"))) as { code: string };
    const matchedCat = (await cat.next(isType("matched"))) as { code: string };
    expect(matchedAnn.code).toBe(matchedCat.code);
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
    await stubChart(12);
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await ann.next(isType("queued"));
    const twin = await queue("pop");
    twin.send({ type: "join", name: "ann" });
    await twin.next((m) => m.type === "error" && m.code === "taken");
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
    expect(body).toContain("8,000");
    // A one-player room writes points but never a win.
    expect(body).toContain("0 wins");
    expect(body).not.toContain("/u/shy");
    const all = await (
      await app.fetch(
        new Request(`${origin}/play/board?period=all`),
        testEnv() as never,
      )
    ).text();
    expect(all).toContain("17,000");
  });
});
