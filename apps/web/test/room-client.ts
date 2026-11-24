// A device in a room, driven over real sockets through the Worker, for the
// tests that need the Workers runtime. Every request goes through SELF: a
// stub made inside the test's own request context would keep the object
// referenced and block its eviction.
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { expect, vi } from "vitest";
import { seedCatalog } from "./catalog";

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const id = /track\/(\d+)/.exec(String(input))?.[1];
      if (id === undefined) return Response.json({ data: [] });
      return Response.json({
        id: Number(id),
        title: "x",
        link: `https://www.deezer.com/track/${id}`,
        preview: `https://cdn.example/${id}.mp3`,
        artist: { name: "Artist" },
        album: { cover_medium: `https://cdn.example/${id}.jpg` },
      });
    }),
  );
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

export class Client {
  inbox: Message[] = [];
  closedWith: number | null = null;
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.inbox.push(JSON.parse(String(event.data)));
    });
    ws.addEventListener("close", (event) => {
      this.closedWith = event.code;
    });
  }
  send(value: unknown) {
    this.ws.send(JSON.stringify(value));
  }
  // The newest message that matches, waiting up to 3 s for it to arrive.
  // It counts polls, since a test may hold Date still.
  async next(match: (m: Message) => boolean) {
    for (let poll = 0; poll < 150; poll += 1) {
      const found = this.inbox.findLast(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no matching message; got ${JSON.stringify(this.inbox)}`);
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

// Answers each round right as soon as it opens, and ends each reveal on the
// room's alarm, until the game is over.
export async function playOut(client: Client, code: string, rounds: number) {
  for (let round = 1; round <= rounds; round += 1) {
    const playing = await client.next(
      (m) => m.type === "state" && m.phase === "playing" && m.round === round,
    );
    setClock((playing.startedAt as number) + 1_000);
    client.send({ type: "answer", answer: titleOfClip(playing) });
    const { reveal } = (await client.next(
      (m) =>
        m.phase === "reveal" &&
        (m.reveal as { number: number }).number === round,
    )) as { reveal: { until: number } };
    setClock(reveal.until);
    expect(await runDurableObjectAlarm(roomStub(code))).toBe(true);
  }
  return client.state("done");
}
