import { beforeAll, describe, expect, it, vi } from "vitest";

// Drives client/room.js against a fake DOM: every element is a stub that
// records its children, and state messages arrive through a fake WebSocket.
// The tests run in the Workers runtime, which has no DOM of its own.
type Stub = {
  [key: string]: unknown;
  id: string;
  hidden: boolean;
  open: boolean;
  textContent: string;
  value: string;
  children: unknown[];
  dataset: Record<string, string>;
  append: (...nodes: unknown[]) => void;
};

let clones = 0;
const makeEl = (id = ""): Stub => {
  const stub: Stub = {
    id,
    hidden: true,
    open: false,
    textContent: "",
    value: "",
    className: "",
    src: "",
    href: "",
    volume: 1,
    paused: true,
    children: [],
    childNodes: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, transform: "" },
    classList: { add() {}, toggle() {}, remove() {}, contains: () => false },
    elements: new Proxy({}, { get: () => ({ value: "" }) }),
    content: {
      firstElementChild: {
        cloneNode: () => {
          clones += 1;
          return makeEl();
        },
      },
    },
    append(...nodes: unknown[]) {
      stub.children.push(...nodes);
    },
    replaceChildren(...nodes: unknown[]) {
      stub.children = [...nodes];
    },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    toggleAttribute() {},
    remove() {},
    focus() {},
    select() {},
    reset() {},
    pause() {},
    load() {},
    play: async () => {},
    closest: () => null,
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
  return stub;
};

const els = new Map<string, Stub>();
const byId = (id: string) => {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id)!;
};
byId("game").dataset = { code: "ABCD23", user: "1" };
byId("clip").closest = () => makeEl();

const listeners: Record<string, (event: unknown) => void> = {};
vi.stubGlobal("document", {
  getElementById: byId,
  createElement: () => makeEl(),
  createDocumentFragment: () => makeEl(),
  addEventListener: (type: string, fn: (event: unknown) => void) => {
    listeners[type] = fn;
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: makeEl(),
});

class FakeSocket {
  static last: FakeSocket;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {}
  deliver(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const revealState = (number: number, track: string) => ({
  type: "state",
  kind: "room",
  code: "ABCD23",
  category: "Pop",
  categorySlug: "pop",
  mode: "easy",
  phase: "reveal",
  now: Date.now(),
  rounds: 10,
  seats: 8,
  you: { name: "Ann", creator: true, user: true, marks: [], streak: 0 },
  players: [{ name: "Ann", creator: true, score: 0, connected: true }],
  reveal: {
    number,
    track,
    title: "Song",
    artist: "Artist",
    until: Date.now() + 5000,
    choices: [],
    results: [],
  },
});

// The visible words of a stub and everything it holds.
const text = (node: unknown): string =>
  typeof node === "string"
    ? node
    : `${(node as Stub).textContent}${(node as Stub).children.map(text).join("")}`;

vi.stubGlobal("location", {
  protocol: "https:",
  host: "earshot.rising.sh",
  origin: "https://earshot.rising.sh",
  pathname: "/play/room/ABCD23",
  search: "",
});
vi.stubGlobal("WebSocket", FakeSocket);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("history", { replaceState: () => {} });
vi.stubGlobal("navigator", {});
vi.stubGlobal("requestAnimationFrame", () => {});
vi.stubGlobal("matchMedia", () => ({ matches: false }));

describe("room.js reveal", () => {
  beforeAll(async () => {
    // @ts-expect-error plain browser script has no type declarations
    await import("../client/room.js");
    await Promise.resolve();
  });

  it("builds the now-playing card once per round, so an open report stays open", () => {
    FakeSocket.last.deliver(revealState(1, "dz:1"));
    const first = clones;
    FakeSocket.last.deliver(revealState(1, "dz:1"));
    expect(clones).toBe(first);
    FakeSocket.last.deliver(revealState(2, "dz:2"));
    expect(clones).toBeGreaterThan(first);
  });

  it("heads the final reveal's card with the verdict and the results", () => {
    FakeSocket.last.deliver(revealState(10, "dz:10"));
    expect(byId("verdict-word").textContent).toBe("Time ran out");
    expect(byId("room-slot").dataset.v).toBe("late");
    expect(byId("slot-note").textContent).toBe(
      "The results come when the bar above fills.",
    );
  });

  it("shows the failure hint when the report is rejected", async () => {
    const form = makeEl();
    form.action = "/play/report";
    form.closest = () => makeEl();
    vi.stubGlobal(
      "FormData",
      class {
        entries() {
          return [][Symbol.iterator]();
        }
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, type: "basic", status: 429 })),
    );
    listeners.submit!({
      preventDefault() {},
      target: {
        closest: (sel: string) => (sel === ".report-form" ? form : null),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(form.children.map(text)).toContain("Could not send the report.");
  });

  it("shows the away screen once the seat moves to another device", () => {
    FakeSocket.last.deliver({ type: "moved" });
    expect(byId("away-panel").hidden).toBe(false);
    expect(byId("round").hidden).toBe(true);
  });
});
