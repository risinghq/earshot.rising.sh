// A device in a room, driven over real sockets through the Worker, for the
// tests that need the Workers runtime. Every request goes through SELF: a
// stub made inside the test's own request context would keep the object
// referenced and block its eviction.
import { env, SELF } from "cloudflare:test";
import { expect, vi } from "vitest";
import { seedCatalog } from "./catalog";
import { deezerTracks, network } from "./network";

export type Message = Record<string, unknown>;

export const origin = "https://music.rising.sh";

// Catalog track 100 + i is "Song i" in pop and 200 + i in rock; its Deezer
// clip names the id, so a test reads the answer off the clip a device got.
export async function stubChart(count: number) {
  const titles = Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    title: `Song ${i}`,
  }));
  await seedCatalog(env.DB, "pop", titles);
  await seedCatalog(
    env.DB,
    "rock",
    titles.map(({ id, title }) => ({ id: id + 100, title })),
  );
  network.use(deezerTracks());
}

export const titleOfClip = (state: Message) => {
  const id = Number(/(\d+)\.mp3$/.exec(String(state.clip))![1]);
  return `Song ${id % 100}`;
};

// The tests and the object share one isolate, so faking Date moves the
// room's clock too: a round opens a few seconds after it is served, and a
// test jumps there instead of waiting. The caller restores real timers.
export const setClock = (now: number) =>
  vi.useFakeTimers({ toFake: ["Date"], now });

export const roomStub = (code: string) =>
  env.ROOMS.get(env.ROOMS.idFromName(code));

interface Waiter {
  match: (m: Message) => boolean;
  resolve: (m: Message) => void;
  reject: (error: Error) => void;
}

export class Client {
  inbox: Message[] = [];
  readonly closed: Promise<number>;
  private waiters: Waiter[] = [];
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      const message: Message = JSON.parse(String(event.data));
      this.inbox.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.match(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        for (const waiter of this.waiters)
          waiter.reject(
            new Error(
              `closed ${event.code}; got ${JSON.stringify(this.inbox)}`,
            ),
          );
        this.waiters = [];
        resolve(event.code);
      });
    });
  }
  send(value: unknown) {
    this.ws.send(JSON.stringify(value));
  }
  // The newest message that matches, or the next one to arrive.
  next(match: (m: Message) => boolean) {
    const found = this.inbox.findLast(match);
    if (found) return Promise.resolve(found);
    return new Promise<Message>((resolve, reject) => {
      this.waiters.push({ match, resolve, reject });
    });
  }
  state(phase: string) {
    return this.next((m) => m.type === "state" && m.phase === phase);
  }
  async join(name?: string, token?: string) {
    this.send({ type: "join", name, token });
    return this.next((m) => m.type === "joined");
  }
  close() {
    this.ws.close();
  }
}

export async function openSocket(path: string, cookie?: string) {
  const headers: Record<string, string> = { upgrade: "websocket" };
  if (cookie) headers.cookie = cookie;
  const response = await SELF.fetch(`${origin}${path}`, { headers });
  expect(response.status).toBe(101);
  return new Client(response.webSocket!);
}

export const connect = (code: string, cookie?: string) =>
  openSocket(`/play/room/${code}/ws`, cookie);
