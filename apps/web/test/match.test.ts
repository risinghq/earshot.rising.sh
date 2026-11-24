// The match queue as the runtime runs it: the route, the Matchmaker's
// hibernated sockets and the room it opens. The queue's rules are in
// match-host.test.ts.
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
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

const matchmaker = () =>
  env.MATCHMAKER.get(env.MATCHMAKER.idFromName("global"));

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

  it("keeps a queued player through the matchmaker's eviction", async () => {
    await stubChart(12);
    const ann = await queue("pop");
    ann.send({ type: "join", name: "Ann" });
    await ann.next(isType("queued"));
    // The seat lives on the hibernated socket, not in the object's memory.
    await evictDurableObject(matchmaker());
    const bob = await queue("pop");
    bob.send({ type: "join", name: "Bob" });
    const matchedAnn = (await ann.next(isType("matched"))) as { code: string };
    const matchedBob = (await bob.next(isType("matched"))) as { code: string };
    expect(matchedAnn.code).toBe(matchedBob.code);
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
