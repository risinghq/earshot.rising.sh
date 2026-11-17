import { beforeAll, describe, expect, it, vi } from "vitest";

// Drives public/room.js's reveal renderer against a fake DOM, the same way
// match-js.test.ts drives match.js: elements are stubs, state messages are
// delivered through a fake WebSocket.
const baseEl = () => ({
  hidden: true,
  open: false,
  textContent: "",
  value: "",
  className: "",
  src: "",
  href: "",
  volume: 1,
  dataset: {},
  listeners: {} as Record<string, (event: unknown) => void>,
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners[type] = fn;
  },
  replaceChildren() {},
  append() {},
  classList: { add: () => {}, toggle: () => {}, remove: () => {} },
  reset() {},
  play: async () => {},
  pause() {},
  removeAttribute() {},
  setAttribute() {},
  querySelector: null as never,
});
type Stub = Omit<ReturnType<typeof baseEl>, "querySelector"> & {
  querySelector: (sel: string) => Stub;
};
const makeEl = (): Stub => {
  const stub = baseEl();
  (stub as never as Stub).querySelector = () => makeEl();
  return stub as never as Stub;
};

const els = new Map<string, Stub>();
const el = (id: string, dataset: Record<string, string> = {}) => {
  const stub = makeEl();
  stub.dataset = dataset;
  els.set(id, stub);
  return stub;
};

el("room", { code: "abcd" });
for (const id of [
  "join-card",
  "lobby-card",
  "game-card",
  "reveal-card",
  "final-card",
  "players-card",
  "room-link",
  "room-meta",
  "room-error",
  "join-form",
  "nickname",
  "lobby-hint",
  "start-button",
  "round-title",
  "count-left",
  "count-bar",
  "clip",
  "clip-status",
  "clip-toggle",
  "clip-volume",
  "choices",
  "typed-form",
  "typed-answer",
  "answer-status",
  "points-hint",
  "players",
  "player-wrap",
  "reveal-title",
  "reveal-track",
  "reveal-artist",
  "reveal-cover",
  "reveal-link",
  "reveal-scores",
  "standings",
  "board",
  "board-empty",
  "rematch-button",
])
  el(id);

const report = el("reveal-report");
const reason = makeEl();
const failHint = makeEl();
const fields = {
  "#report-track": el("report-track"),
  "#report-title": el("report-title"),
  "#report-artist": el("report-artist"),
  "#report-category": el("report-category"),
  "#report-back": el("report-back"),
  select: reason,
  ".report-failed": failHint,
};
const form = {
  action: "/play/report",
  reset: vi.fn(),
  querySelector: (sel: string) => fields[sel as never] ?? makeEl(),
};
report.querySelector = (sel: string) =>
  sel === "form" ? (form as never) : (fields[sel as never] ?? makeEl());

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

const revealState = (track: string) => ({
  type: "state",
  phase: "reveal",
  rounds: 10,
  categorySlug: "pop",
  you: { name: "Ann", creator: true, user: true },
  players: [],
  reveal: { number: 1, track, title: "Song", artist: "Artist", results: [] },
});

vi.stubGlobal("document", {
  getElementById: (id: string) => els.get(id),
  createElement: () => makeEl(),
});
vi.stubGlobal("location", {
  protocol: "https:",
  host: "music.rising.sh",
  origin: "https://music.rising.sh",
  pathname: "/play/room/abcd",
  search: "",
});
vi.stubGlobal("WebSocket", FakeSocket);
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("history", { replaceState: () => {} });
vi.stubGlobal("navigator", { vibrate: () => {} });
vi.stubGlobal("requestAnimationFrame", () => {});
vi.stubGlobal("matchMedia", () => ({ matches: false }));

describe("room.js report details", () => {
  beforeAll(async () => {
    // @ts-expect-error plain browser script has no type declarations
    await import("../public/room.js");
    await Promise.resolve();
  });

  it("keeps an in-progress report across repeat reveal states", () => {
    FakeSocket.last.deliver(revealState("dz:1"));
    expect(report.open).toBe(false);
    report.open = true;
    reason.value = "bad_clip";
    FakeSocket.last.deliver(revealState("dz:1"));
    expect(report.open).toBe(true);
    expect(reason.value).toBe("bad_clip");
    FakeSocket.last.deliver(revealState("dz:2"));
    expect(report.open).toBe(false);
    expect(form.reset).toHaveBeenCalled();
  });

  it("shows the failure hint when the report is rejected", async () => {
    FakeSocket.last.deliver(revealState("dz:3"));
    const submit = report.listeners.submit!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, type: "basic", status: 429 })),
    );
    submit({ preventDefault: () => {}, target: form });
    await Promise.resolve();
    await Promise.resolve();
    expect(failHint.hidden).toBe(false);
  });
});
