// The match queue, driven through fake ports: no Workers runtime. What only
// the runtime shows (the route, hibernated sockets, the room it opens) is in
// match.test.ts.
import { describe, expect, it } from "vitest";
import {
  MatchHost,
  type MatchPorts,
  type MatchSocket,
  type Pool,
  type Seat,
} from "../src/play/match/host";
import type { MatchServerMessage } from "../src/play/room/protocol";
import type { RoomInit } from "../src/play/room/game";

class FakeSocket implements MatchSocket {
  inbox: MatchServerMessage[] = [];
  open = true;
  private stored: Seat;

  constructor(seat: Seat) {
    this.stored = structuredClone(seat);
  }

  // The real attachment is serialised, so a seat changed without setSeat
  // is not kept.
  seat() {
    return structuredClone(this.stored);
  }
  setSeat(seat: Seat) {
    this.stored = structuredClone(seat);
  }
  send(message: MatchServerMessage) {
    if (this.open) this.inbox.push(message);
  }
  isOpen() {
    return this.open;
  }
  last() {
    return this.inbox.at(-1);
  }
}

const pool: Pool = { slug: "pop", name: "Pop", candidates: [] };

function deferred() {
  let release = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
}

function world() {
  const sockets: FakeSocket[] = [];
  const rooms: RoomInit[] = [];
  const w = {
    clock: 1_000,
    sockets,
    rooms,
    pool: async (slug: string, _era: number | null): Promise<Pool | null> => ({
      ...pool,
      slug,
    }),
    openRoom: async (init: RoomInit) => {
      rooms.push(init);
      return true;
    },
  };
  let ids = 0;
  const ports: MatchPorts = {
    now: () => w.clock,
    // A closed socket drops out of the object's list.
    sockets: () => sockets.filter((s) => s.open),
    pool: (slug, era) => w.pool(slug, era),
    openRoom: (init) => w.openRoom(init),
    newCode: () => `ROOM${++ids}`,
    newSecret: () => `secret${++ids}`,
  };
  const host = new MatchHost(ports);
  const connect = (over: Partial<Seat> = {}) => {
    const socket = new FakeSocket({
      category: "pop",
      era: null,
      uid: null,
      anon: null,
      name: "",
      queued: 0,
      ...over,
    });
    sockets.push(socket);
    return socket;
  };
  const queue = async (name: string, over: Partial<Seat> = {}) => {
    const socket = connect(over);
    await host.join(socket, { type: "join", name });
    w.clock += 1_000;
    return socket;
  };
  return Object.assign(w, { host, connect, queue });
}

const matched = (s: FakeSocket) =>
  s.inbox.find((m) => m.type === "matched") as
    | { type: "matched"; code: string; token: string }
    | undefined;

describe("match queue", () => {
  it("pairs two guests in one category into one room", async () => {
    const w = world();
    const ann = await w.queue("Ann");
    expect(ann.last()).toEqual({ type: "queued" });
    const bob = await w.queue("Bob");
    expect(w.rooms).toHaveLength(1);
    const room = w.rooms[0];
    expect(room).toMatchObject({ kind: "match", categorySlug: "pop" });
    expect(room.players.map((p) => p.name)).toEqual(["Ann", "Bob"]);
    expect(matched(ann)).toEqual({
      type: "matched",
      code: room.code,
      token: room.players[0].token,
    });
    expect(matched(bob)?.token).toBe(room.players[1].token);
    expect(w.host.waiting()).toEqual([]);
  });

  it("does not pair players in different categories or eras", async () => {
    const w = world();
    await w.queue("Ann", { category: "pop" });
    await w.queue("Bob", { category: "rock" });
    await w.queue("Cid", { category: "pop", era: 1990 });
    expect(w.rooms).toEqual([]);
    expect(w.host.waiting().map((e) => e.seat.name)).toEqual([
      "Ann",
      "Bob",
      "Cid",
    ]);
  });

  it("drops a player whose socket closed from the line", async () => {
    const w = world();
    const ann = await w.queue("Ann");
    ann.open = false;
    const bob = await w.queue("Bob");
    expect(bob.last()).toEqual({ type: "queued" });
    expect(w.rooms).toEqual([]);
  });

  it("asks a second guest with the same nickname to pick another", async () => {
    const w = world();
    await w.queue("Ann");
    const twin = await w.queue("ann");
    expect(twin.last()).toEqual({ type: "error", code: "taken" });
    expect(w.host.waiting()).toHaveLength(1);
  });

  it("seats a signed-in player by their account name", async () => {
    const w = world();
    await w.queue("", { uid: 7, name: "ann_gh" });
    await w.queue("Bob");
    expect(w.rooms[0].players).toMatchObject([
      { name: "ann_gh", userId: 7 },
      { name: "Bob", userId: null },
    ]);
  });

  it("refuses a guest with no nickname or one that is too long", async () => {
    const w = world();
    const blank = await w.queue("  ");
    const long = await w.queue("x".repeat(21));
    expect(blank.last()).toEqual({ type: "error", code: "name" });
    expect(long.last()).toEqual({ type: "error", code: "name" });
    expect(w.host.waiting()).toEqual([]);
  });

  it("ignores a second join from a player already in line", async () => {
    const w = world();
    const ann = await w.queue("Ann");
    await w.host.join(ann, { type: "join", name: "Ann" });
    expect(ann.inbox).toEqual([{ type: "queued" }]);
  });

  it("tells both players when the category has too few tracks", async () => {
    const w = world();
    w.pool = async () => null;
    const ann = await w.queue("Ann");
    const bob = await w.queue("Bob");
    expect(ann.last()).toEqual({ type: "error", code: "feed" });
    expect(bob.last()).toEqual({ type: "error", code: "feed" });
    expect(w.rooms).toEqual([]);
  });

  it("tells both players when their room cannot be opened", async () => {
    const w = world();
    w.openRoom = async () => false;
    const ann = await w.queue("Ann");
    const bob = await w.queue("Bob");
    expect(ann.last()).toEqual({ type: "error", code: "feed" });
    expect(bob.last()).toEqual({ type: "error", code: "feed" });
  });

  it("pairs the survivor with the next waiter when a partner leaves while tracks load", async () => {
    const w = world();
    const gate = deferred();
    const load = w.pool;
    w.pool = async (slug, era) => {
      await gate.done;
      return load(slug, era);
    };
    const ann = await w.queue("Ann");
    const bob = w.connect();
    const pairing = w.host.join(bob, { type: "join", name: "Bob" });
    const cat = await w.queue("Cat");
    expect(cat.last()).toEqual({ type: "queued" });
    bob.open = false;
    gate.release();
    await pairing;
    expect(w.rooms.map((r) => r.players.map((p) => p.name))).toEqual([
      ["Cat", "Ann"],
    ]);
    expect(matched(ann)).toBeDefined();
    expect(matched(cat)).toBeDefined();
    expect(bob.inbox).toEqual([]);
  });

  it("puts the survivor back in line when a partner leaves while the room opens", async () => {
    const w = world();
    const ann = await w.queue("Ann");
    const place = ann.seat()!.queued;
    const bob = w.connect();
    w.openRoom = async (init) => {
      w.rooms.push(init);
      bob.open = false;
      return true;
    };
    await w.host.join(bob, { type: "join", name: "Bob" });
    expect(matched(ann)).toBeUndefined();
    expect(ann.last()).toEqual({ type: "queued" });
    expect(w.host.waiting().map((e) => e.seat)).toMatchObject([
      { name: "Ann", queued: place },
    ]);
  });
});
