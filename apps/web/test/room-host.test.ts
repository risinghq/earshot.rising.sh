import { describe, expect, it } from "vitest";
import type { Category } from "../src/play/catalog/catalog";
import type { GameStart, Outcome } from "../src/play/game/outcomes";
import type { ServerMessage } from "../src/play/room/protocol";
import { scoreFor } from "../src/play/game/quiz";
import type { Mode } from "../src/play/game/rules";
import type { CategoryBoardEntry, ResultRow } from "../src/play/game/results";
import {
  QuotaError,
  type Candidate,
  type Preview,
} from "../src/play/catalog/sources";
import type { RoomInit, Stored } from "../src/play/room/game";
import { idleMs, matchWaitMs, revealMs } from "../src/play/room/game";
import {
  RoomHost,
  type ClientMessage,
  type RoomPorts,
  type Socket,
  type SocketInfo,
} from "../src/play/room/host";

type Message = ServerMessage & Record<string, unknown>;

class FakeSocket implements Socket {
  inbox: Message[] = [];
  closed: number | null = null;
  constructor(private data: SocketInfo) {}
  info = () => this.data;
  setInfo = (info: SocketInfo) => {
    this.data = info;
  };
  send = (message: ServerMessage) => {
    this.inbox.push(message as Message);
  };
  close = (code: number) => {
    this.closed = code;
  };
  last(type: string, test: (m: Message) => boolean = () => true) {
    return this.inbox.findLast((m) => m.type === type && test(m));
  }
  get state() {
    return this.last("state") as Message | undefined;
  }
}

const songs = (count: number): Candidate[] =>
  Array.from({ length: count }, (_, i) => ({
    title: `Song ${i}`,
    artist: "Artist",
    cover: null,
    link: null,
  }));

const clipFor = (candidate: Pick<Candidate, "title">) =>
  `https://cdn.example/${encodeURIComponent(candidate.title)}.mp3`;

// The room with fake ports: a clock the test moves, sockets it opens, and a
// record of every write the room asks for.
function world(init: Partial<RoomInit> = {}) {
  let ids = 0;
  const w = {
    now: 1_000_000,
    sockets: [] as FakeSocket[],
    saved: undefined as Stored | undefined,
    alarm: null as number | null,
    erased: false,
    background: [] as Promise<unknown>[],
    starts: [] as GameStart[],
    outcomes: [] as { rows: Outcome[]; phase: string | undefined }[],
    results: [] as ResultRow[],
    board: [] as CategoryBoardEntry[],
    categories: {
      rock: { slug: "rock", name: "Rock", feed: "deezer_chart", ref: null },
      mine: { slug: "mine", name: "Mine", feed: "mine", ref: null },
    } as Record<string, Category>,
    preview: async (candidate: Candidate): Promise<Preview | null> => ({
      url: clipFor(candidate),
      link: null,
      cover: null,
    }),
    draw: null as Candidate[] | null,
    draws: [] as { players: number; candidates: number; mode: Mode }[],
    finale: (candidates: Candidate[]) => candidates,
    finales: [] as number[],
    failOutcomes: false,
  };
  const ports: RoomPorts = {
    now: () => w.now,
    sockets: () => w.sockets,
    save: async (s) => {
      w.saved = structuredClone(s);
    },
    erase: async () => {
      w.erased = true;
      w.saved = undefined;
    },
    setAlarm: async (at) => {
      w.alarm = at;
    },
    background: (work) => w.background.push(work),
    newId: () => `id${(ids += 1)}`,
    newSecret: () => `secret${(ids += 1)}`,
    preview: (candidate) => w.preview(candidate),
    category: async (slug) => w.categories[slug] ?? null,
    recordGameStart: async (start) => {
      w.starts.push(start);
    },
    recordOutcomes: async (rows) => {
      w.outcomes.push({ rows, phase: w.saved?.phase });
      if (w.failOutcomes) throw new Error("D1 refused");
    },
    weightedDraw: async (players, candidates, mode) => {
      w.draws.push({
        players: players.length,
        candidates: candidates.length,
        mode,
      });
      return w.draw;
    },
    finale: async (candidates) => {
      w.finales.push(candidates.length);
      return w.finale(candidates);
    },
    recordResults: async (rows) => {
      w.results.push(...rows);
    },
    readBoard: async () => w.board,
  };
  let host = new RoomHost(ports, undefined);
  const ready = host.init({
    code: "ROOMAB",
    kind: "room",
    categorySlug: "pop",
    categoryName: "Pop",
    mode: "normal",
    candidates: songs(10),
    creatorToken: "host",
    players: [],
    ...init,
  });
  const send = (socket: FakeSocket, message: ClientMessage) =>
    host.message(socket, message);
  const open = (info: SocketInfo = {}) => {
    const socket = new FakeSocket(info);
    w.sockets.push(socket);
    return socket;
  };
  return {
    w,
    get host() {
      return host;
    },
    send,
    open,
    // The object is evicted: a new host loads what was saved, its sockets
    // stay open, and the in-memory clip is gone.
    evict() {
      host = new RoomHost(ports, structuredClone(w.saved));
    },
    // Opens a socket and takes a seat on it.
    async seat(name: string | undefined, token?: string, info?: SocketInfo) {
      await ready;
      const socket = open(info);
      await send(socket, { type: "join", name, token });
      return socket;
    },
    async watch() {
      await ready;
      const socket = open();
      await send(socket, { type: "watch" });
      return socket;
    },
    async leave(socket: FakeSocket) {
      w.sockets = w.sockets.filter((other) => other !== socket);
      await host.left();
    },
    // Moves the clock to the armed alarm and fires it.
    async fire() {
      w.now = Math.max(w.now, w.alarm!);
      await host.alarm();
    },
    async at(time: number) {
      w.now = time;
      await host.alarm();
    },
    // The title of the clip on the screen or the phones right now.
    playingTitle() {
      const round = w.saved!.round!;
      return w.saved!.candidates[round.index].title;
    },
    async answerAll(...players: FakeSocket[]) {
      const round = w.saved!.round!;
      w.now = Math.max(w.now, round.startedAt + 1_000);
      for (const player of players)
        await send(player, { type: "answer", answer: this.playingTitle() });
    },
    // Plays every round out: each player answers, then the reveal ends.
    async playOut(...players: FakeSocket[]) {
      while (w.saved!.phase !== "done") {
        if (w.saved!.phase === "playing") await this.answerAll(...players);
        else await this.fire();
      }
    },
  };
}

describe("a game", () => {
  it("records the start, then each round's outcomes after the reveal is saved", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    const bob = await room.seat("Bob");
    await room.send(ann, { type: "start" });
    expect(room.w.starts).toMatchObject([{ origin: "start", players: 2 }]);
    await room.answerAll(ann, bob);
    expect(room.w.outcomes).toHaveLength(1);
    expect(room.w.outcomes[0].rows).toHaveLength(2);
    expect(ann.state).toMatchObject({ phase: "reveal" });
  });

  it("plays a room in the order the weighted draw gives", async () => {
    const room = world();
    const order = songs(10).reverse();
    room.w.draw = order;
    const ann = await room.seat("Ann", "host");
    await room.seat("Bob");
    await room.send(ann, { type: "start" });
    expect(room.w.draws).toEqual([
      { players: 2, candidates: 10, mode: "normal" },
    ]);
    expect(room.w.saved!.candidates.map((song) => song.title)).toEqual(
      order.map((song) => song.title),
    );
  });

  it("plays the order the finale gives after the draw", async () => {
    const room = world();
    room.w.draw = songs(10);
    room.w.finale = (candidates) => [...candidates.slice(1), candidates[0]];
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    expect(room.w.finales).toEqual([10]);
    expect(room.w.saved!.candidates.at(-1)!.title).toBe("Song 0");
  });

  it("keeps the drawn order when the finale lookup fails", async () => {
    const room = world();
    room.w.draw = songs(10);
    room.w.finale = () => {
      throw new Error("D1 refused");
    };
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    expect(room.w.saved!.candidates[0].title).toBe("Song 0");
    expect(ann.state).toMatchObject({ phase: "playing" });
  });

  it("keeps the plain shuffle for a match", async () => {
    const room = world({
      kind: "match",
      creatorToken: "",
      candidates: songs(4),
      players: [{ name: "ann", token: "a", userId: 7 }],
    });
    await room.seat(undefined, "a", { uid: 7, name: "ann" });
    await room.fire();
    expect(room.w.starts).toMatchObject([{ origin: "match" }]);
    expect(room.w.draws).toEqual([]);
  });

  it("reaches the reveal when the outcome write fails", async () => {
    const room = world();
    room.w.failOutcomes = true;
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    await room.answerAll(ann);
    expect(ann.state).toMatchObject({ phase: "reveal" });
    expect(room.w.saved!.round).toBeNull();
  });

  it("plays to the final standings, with the category board", async () => {
    const room = world();
    room.w.board = [
      { name: "pro", score: 7000, correct: 9, rounds: 10, finished_at: 1 },
    ];
    const screen = await room.watch();
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    await room.playOut(ann);
    for (const device of [ann, screen])
      expect(device.state).toMatchObject({
        phase: "done",
        standings: [{ name: "Ann", correct: 10 }],
        board: [{ name: "pro", score: 7000 }],
      });
  });

  it("closes the round when the last unanswered player leaves", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    const bob = await room.seat("Bob");
    await room.send(ann, { type: "start" });
    await room.answerAll(ann);
    expect(ann.state).toMatchObject({ phase: "playing" });
    await room.leave(bob);
    expect(ann.state).toMatchObject({ phase: "reveal" });
  });

  it("starts the round early once every device reports the clip", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    const bob = await room.seat("Bob");
    await room.send(ann, { type: "start" });
    const provisional = ann.state!.startedAt as number;
    await room.send(ann, { type: "loaded" });
    expect(ann.state!.startedAt).toBe(provisional);
    await room.send(bob, { type: "loaded" });
    expect(ann.state!.startedAt).toBeLessThan(provisional);
  });

  it("keeps the points on a reconnect with the seat token", async () => {
    const room = world();
    const first = await room.seat("Ann", "host");
    await room.send(first, { type: "start" });
    await room.answerAll(first);
    const score = room.w.saved!.players[0].score;
    expect(score).toBeGreaterThan(0);
    await room.leave(first);
    const again = await room.seat(undefined, "host");
    expect(again.last("joined")).toMatchObject({ name: "Ann" });
    expect(again.state).toMatchObject({ players: [{ name: "Ann", score }] });
  });
});

describe("clips", () => {
  it("stamps the round start after a slow clip lookup", async () => {
    const room = world();
    const lookup = room.w.preview;
    room.w.preview = async (candidate) => {
      room.w.now += 1_600;
      return lookup(candidate);
    };
    const ann = await room.seat("Ann", "host");
    const asked = room.w.now;
    await room.send(ann, { type: "start" });
    expect(ann.state!.startedAt).toBe(asked + 1_600 + 5_500);
  });

  it("holds the same song after a quota answer and retries it", async () => {
    const room = world();
    const lookup = room.w.preview;
    room.w.preview = async () => {
      room.w.now += 100;
      throw new QuotaError("quota");
    };
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    expect(ann.state).toMatchObject({ phase: "loading", round: 1 });
    // The retry time is stamped after the lookup answered.
    expect(room.w.alarm).toBe(room.w.now + 2_500);
    room.w.preview = lookup;
    await room.fire();
    expect(ann.state).toMatchObject({ phase: "playing", round: 1 });
    expect(room.w.saved!.round!.index).toBe(0);
  });

  it("skips a song with no clip", async () => {
    const room = world();
    const asked: string[] = [];
    room.w.preview = async (candidate) => {
      asked.push(candidate.title);
      return asked.length === 1
        ? null
        : { url: clipFor(candidate), link: null, cover: null };
    };
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    expect(asked).toHaveLength(2);
    expect(room.playingTitle()).toBe(asked[1]);
    expect(ann.state).toMatchObject({ phase: "playing", round: 1 });
  });

  it("re-resolves the clip after an eviction for a player who comes back", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    room.evict();
    room.w.sockets = [];
    const back = await room.seat(undefined, "host");
    await Promise.all(room.w.background);
    expect(back.state!.clip).toBe(clipFor({ title: room.playingTitle() }));
  });

  it("does not let a late re-resolved clip overwrite the next round", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    room.evict();
    let release = () => {};
    const lookup = room.w.preview;
    room.w.preview = (candidate) =>
      new Promise((resolve) => {
        release = () => resolve(lookup(candidate));
      });
    room.w.sockets = [];
    const back = await room.seat(undefined, "host");
    room.w.preview = lookup;
    // The round ends and the next one is served before the lookup lands.
    await room.fire();
    await room.fire();
    const next = back.state!.clip;
    release();
    await Promise.all(room.w.background);
    expect(back.state!.clip).toBe(next);
    expect(back.state).toMatchObject({ phase: "playing", round: 2 });
    expect(next).toBe(clipFor({ title: room.playingTitle() }));
  });
});

describe("screens", () => {
  it("watches without taking a seat and sees who joins", async () => {
    const room = world();
    const screen = await room.watch();
    expect(screen.state).toMatchObject({ watch: true, you: { name: "" } });
    expect(screen.last("joined")).toBeUndefined();
    await room.seat("Ann", "host");
    expect(screen.state).toMatchObject({ players: [{ name: "Ann" }] });
  });

  it("plays the clip on the screen and flags the phones", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    const screen = await room.watch();
    expect(ann.state).toMatchObject({ screen: true });
    await room.send(ann, { type: "start" });
    expect(ann.state!.clip).toBeUndefined();
    expect(ann.state!.choices).toHaveLength(4);
    expect(screen.state!.clip).toMatch(/^https:\/\/cdn\.example\//);
  });

  it("does not let a screen fill a match seat", async () => {
    const room = world({
      kind: "match",
      creatorToken: "",
      players: [
        { name: "Ann", token: "a", userId: null },
        { name: "Bob", token: "b", userId: null },
      ],
    });
    await room.watch();
    const ann = await room.seat(undefined, "a");
    expect(ann.state).toMatchObject({ phase: "lobby" });
    await room.seat(undefined, "b");
    expect(room.w.starts).toMatchObject([{ origin: "match", players: 2 }]);
  });
});

describe("seats", () => {
  it("previews the room to a guest who has not picked a name", async () => {
    const room = world();
    await room.seat(undefined, "host");
    const guest = await room.seat(undefined);
    expect(guest.last("preview")).toMatchObject({
      category: "Pop",
      players: ["Host"],
    });
    expect(guest.last("error")).toMatchObject({ code: "name" });
  });

  it("moves a seat to the device that opens its link, and back", async () => {
    const room = world();
    const phone = await room.seat("Ann");
    const { token } = phone.last("joined") as { token: string };
    const laptop = await room.seat(undefined, token);
    expect(laptop.last("joined")).toMatchObject({ name: "Ann" });
    expect(phone.last("moved")).toBeDefined();
    expect(phone.closed).toBe(4001);
    room.w.sockets = room.w.sockets.filter((s) => s !== phone);
    expect(laptop.state).toMatchObject({
      players: [{ name: "Ann", connected: true }],
    });
    await room.seat(undefined, token);
    expect(laptop.closed).toBe(4001);
  });

  it("seats a signed-in player once across devices", async () => {
    const room = world();
    const signedIn = { uid: 7, name: "ann" };
    const phone = await room.seat(undefined, undefined, signedIn);
    const laptop = await room.seat(undefined, undefined, signedIn);
    expect(room.w.saved!.players.map((p) => p.name)).toEqual(["ann"]);
    expect(laptop.state).toMatchObject({
      players: [{ name: "ann", user: true }],
    });
    expect(phone.closed).toBe(4001);
  });

  it("saves a guest's finished game once they sign in from the room", async () => {
    const room = world({ candidates: songs(4) });
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    await room.playOut(ann);
    expect(room.w.results).toEqual([]);
    room.w.board = [
      { name: "ann", score: 3000, correct: 4, rounds: 4, finished_at: 1 },
    ];
    await room.leave(ann);
    const back = await room.seat(undefined, "host", { uid: 7, name: "ann" });
    expect(room.w.results).toMatchObject([{ userId: 7, kind: "room" }]);
    expect(back.state).toMatchObject({
      you: { name: "Ann", user: true },
      board: [{ name: "ann" }],
    });
  });
});

describe("between games", () => {
  it("collects Up next votes and starts the host's pick at once", async () => {
    const room = world({ candidates: songs(4) });
    const ann = await room.seat("Ann", "host");
    const bob = await room.seat("Bob");
    await room.send(ann, { type: "start" });
    await room.playOut(ann, bob);
    await room.send(bob, { type: "suggest", category: "nope", mode: "normal" });
    await room.send(bob, { type: "suggest", category: "mine", mode: "normal" });
    expect(bob.state!.suggestions).toEqual([]);
    await room.send(bob, { type: "suggest", category: "rock", mode: "normal" });
    await room.send(ann, { type: "suggest", category: "rock", mode: "normal" });
    expect(ann.state!.suggestions).toMatchObject([
      { slug: "rock", votes: 2, voted: true, by: "Bob" },
    ]);
    const rock = {
      categorySlug: "rock",
      categoryName: "Rock",
      mode: "normal" as const,
      candidates: songs(4),
    };
    expect(await room.host.retarget("not-the-key", rock, true)).toBe(403);
    expect(await room.host.retarget("host", rock, true)).toBe(204);
    expect(bob.state).toMatchObject({ categorySlug: "rock", phase: "playing" });
    expect(room.w.starts.map((s) => [s.category, s.origin])).toEqual([
      ["pop", "start"],
      ["rock", "pick"],
    ]);
  });
});

describe("deadlines", () => {
  it("closes the round when its time is up and serves the next after the reveal", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    await room.send(ann, { type: "start" });
    await room.fire();
    expect(ann.state).toMatchObject({ phase: "reveal" });
    expect(room.w.alarm).toBe(room.w.now + revealMs);
    await room.fire();
    expect(ann.state).toMatchObject({ phase: "playing", round: 2 });
  });

  it("starts a match with whoever came once the wait is over, and writes their result", async () => {
    const room = world({
      kind: "match",
      creatorToken: "",
      candidates: songs(4),
      players: [
        { name: "ann", token: "a", userId: 7 },
        { name: "Bob", token: "b", userId: null },
      ],
    });
    const ann = await room.seat(undefined, "a", { uid: 7, name: "ann" });
    expect(room.w.alarm).toBe(1_000_000 + matchWaitMs);
    await room.fire();
    expect(room.w.starts).toMatchObject([{ origin: "match", players: 1 }]);
    expect(ann.state).toMatchObject({ phase: "playing" });
    await room.playOut(ann);
    expect(room.w.results).toMatchObject([
      {
        userId: 7,
        kind: "match",
        rank: 1,
        players: 1,
        score: 4 * scoreFor(1_000),
      },
    ]);
  });

  it("deletes an idle room and closes its sockets", async () => {
    const room = world();
    const ann = await room.seat("Ann", "host");
    await room.at(room.w.saved!.lastActive + idleMs);
    expect(room.w.erased).toBe(true);
    expect(ann.closed).toBe(1001);
    const late = await room.seat("Late");
    expect(late.last("error")).toMatchObject({ code: "gone" });
  });
});
