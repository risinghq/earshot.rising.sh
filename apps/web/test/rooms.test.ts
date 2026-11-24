// What only the Workers runtime shows about a room: the routes in front of
// the Durable Object, real hibernatable sockets, storage across an eviction,
// the alarm, and the rows D1 receives. The room's rules and its handling of
// messages are tested without the runtime in room-game and room-host.
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  SELF,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { idleMs } from "../src/play/room-game";
import {
  connect,
  origin,
  playOut,
  roomStub,
  setClock,
  stubChart,
  titleOfClip,
  type Message,
} from "./room-client";

const post = (path: string, fields: Record<string, string>) =>
  SELF.fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body: new URLSearchParams(fields).toString(),
  });

async function createRoom() {
  const response = await post("/play/room", {
    category: "pop",
    mode: "normal",
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location")!, origin);
  const code = /room\/(\w+)/.exec(location.pathname)![1];
  return { code, key: location.searchParams.get("k")! };
}

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function signIn(id: number, name: string) {
  const token = `sess_${id}_${"s".repeat(30)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, github_id, name, is_public, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
    ).bind(id, id, name, now),
    env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
    ).bind(await sha256(token), id, now + 86400),
  ]);
  return `__Host-session=${token}`;
}

const answerable = (playing: Message) =>
  setClock((playing.startedAt as number) + 1_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a room in the runtime", () => {
  it("logs the game and one outcome row per answering player, and reports the revealed track", async () => {
    await stubChart(10);
    const { code, key } = await createRoom();
    const ann = await connect(code);
    const bob = await connect(code);
    await ann.join("Ann", key);
    await bob.join("Bob");
    ann.send({ type: "start" });
    const playing = await ann.state("playing");
    answerable(playing);
    for (const player of [ann, bob])
      player.send({ type: "answer", answer: titleOfClip(playing) });
    const { reveal } = (await ann.state("reveal")) as {
      reveal: { track: string; title: string; artist: string };
    };
    expect(reveal.title).toBe(titleOfClip(playing));

    const games = await env.DB.prepare(
      "SELECT id, kind, category, origin, players FROM games WHERE room = ?1",
    )
      .bind(code)
      .all();
    expect(games.results).toMatchObject([
      { kind: "room", category: "pop", origin: "start", players: 2 },
    ]);
    const outcomes = await env.DB.prepare(
      "SELECT game_id, round, title, category, kind, mode FROM round_outcomes",
    ).all();
    expect(outcomes.results).toHaveLength(2);
    for (const row of outcomes.results)
      expect(row).toMatchObject({
        game_id: games.results[0].id,
        round: 1,
        title: reveal.title,
        category: "pop",
        kind: "room",
        mode: "normal",
      });

    const report = await post("/play/report", {
      track: reveal.track,
      title: reveal.title,
      artist: reveal.artist,
      category: "pop",
      reason: "bad_clip",
    });
    expect(report.status).toBe(303);
    expect(
      await env.DB.prepare(
        "SELECT track_key, title, reason FROM track_reports",
      ).first(),
    ).toEqual({
      track_key: reveal.track,
      title: reveal.title,
      reason: "bad_clip",
    });
  });

  it("keeps the room, its seats and the clip across an eviction", async () => {
    await stubChart(10);
    const { code, key } = await createRoom();
    const phone = await connect(code);
    const { token } = (await phone.join("Ann", key)) as { token: string };
    phone.send({ type: "start" });
    const playing = await phone.state("playing");

    await evictDurableObject(roomStub(code));
    // The phone's socket hibernated with its seat; a new device opening the
    // seat link moves the seat off it, and gets the clip re-resolved.
    const laptop = await connect(code);
    expect(await laptop.join(undefined, token)).toMatchObject({ name: "Ann" });
    await phone.next((m) => m.type === "moved");
    const resumed = await laptop.next(
      (m) => m.type === "state" && m.clip !== undefined,
    );
    expect(resumed).toMatchObject({ phase: "playing", clip: playing.clip });

    answerable(playing);
    laptop.send({ type: "answer", answer: titleOfClip(playing) });
    const revealed = (await laptop.state("reveal")) as {
      players: { name: string; score: number }[];
    };
    expect(revealed.players[0].name).toBe("Ann");
    expect(revealed.players[0].score).toBeGreaterThan(0);
  });

  it("closes an idle room on its alarm, even with a socket open", async () => {
    await stubChart(10);
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await ann.join("Ann", key);
    await ann.state("lobby");
    setClock(Date.now() + idleMs + 1);
    expect(await runDurableObjectAlarm(roomStub(code))).toBe(true);
    await vi.waitFor(() => expect(ann.closedWith).toBe(1001));
    const late = await connect(code);
    late.send({ type: "join", name: "Late" });
    expect(await late.next((m) => m.type === "error")).toMatchObject({
      code: "gone",
    });
  });

  it("switches the room to the host's pick between games and starts it", async () => {
    await stubChart(4);
    const { code, key } = await createRoom();
    const ann = await connect(code);
    await ann.join("Ann", key);
    ann.send({ type: "start" });
    await playOut(ann, code, 4);
    const switchTo = (k: string) =>
      post(`/play/room/${code}/switch`, {
        category: "rock",
        mode: "normal",
        k,
        start: "1",
      });
    expect((await switchTo("not-the-key")).status).toBe(403);
    expect((await switchTo(key)).status).toBe(303);
    expect(
      await ann.next((m) => m.type === "state" && m.phase === "playing"),
    ).toMatchObject({ categorySlug: "rock", round: 1 });
    const games = await env.DB.prepare(
      "SELECT category, origin FROM games WHERE room = ?1 ORDER BY started_at, origin DESC",
    )
      .bind(code)
      .all();
    expect(games.results).toEqual([
      { category: "pop", origin: "start" },
      { category: "rock", origin: "pick" },
    ]);
  });

  it("seats a signed-in player under their name, once across devices", async () => {
    await stubChart(10);
    const { code } = await createRoom();
    const cookie = await signIn(101, "ann");
    const phone = await connect(code, cookie);
    await phone.join();
    const laptop = await connect(code, cookie);
    await laptop.join();
    await phone.next((m) => m.type === "moved");
    expect(await laptop.state("lobby")).toMatchObject({
      players: [{ name: "ann", user: true }],
    });
  });

  it("draws a seat link's QR code and refuses a malformed key", async () => {
    await stubChart(10);
    const { code } = await createRoom();
    // The legacy test origin redirects page GETs; the sheet loads the canonical host.
    const canonical = "https://earshot.rising.sh";
    const seat = await SELF.fetch(
      `${canonical}/play/room/${code}/seat.svg?k=abcdefgh12345678`,
    );
    expect(seat.status).toBe(200);
    expect(seat.headers.get("content-type")).toBe("image/svg+xml");
    expect(seat.headers.get("cache-control")).toBe("private, no-store");
    expect(await seat.text()).toMatch(/^<svg [^>]*viewBox="-4 -4 \d+ \d+"/);
    const bad = await SELF.fetch(
      `${canonical}/play/room/${code}/seat.svg?k=a/b`,
    );
    expect(bad.status).toBe(404);
  });
});
