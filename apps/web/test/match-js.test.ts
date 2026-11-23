import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Drives client/match.js against a fake DOM and WebSocket: the page logic is
// plain JS, so each element is a small stub and messages are delivered by hand.
interface Stub {
  hidden: boolean;
  textContent: string;
  value: string;
  dataset: Record<string, string>;
  onclick: null | (() => void);
  onsubmit: null | ((event: { preventDefault(): void }) => void);
  addEventListener: () => void;
}

const els = new Map<string, Stub>();
const el = (id: string, dataset: Record<string, string> = {}): Stub => {
  const stub: Stub = {
    hidden: true,
    textContent: "",
    value: "",
    dataset,
    onclick: null,
    onsubmit: null,
    addEventListener: () => {},
  };
  els.set(id, stub);
  return stub;
};

el("match", { category: "pop", signedIn: "1" });
for (const id of [
  "match-name-card",
  "match-search-card",
  "match-waited",
  "match-status",
  "match-actions",
  "match-error",
  "match-name-form",
  "match-nickname",
  "match-stop",
])
  el(id);

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
  close() {
    this.readyState = 3;
  }
  deliver(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

vi.stubGlobal("document", { getElementById: (id: string) => els.get(id) });
vi.stubGlobal("location", { protocol: "https:", host: "music.rising.sh" });
vi.stubGlobal("WebSocket", FakeSocket);

describe("match.js", () => {
  beforeAll(async () => {
    // @ts-expect-error plain browser script has no type declarations
    await import("../client/match.js");
    await Promise.resolve();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the waited counter counting after Keep waiting", () => {
    vi.useFakeTimers();
    FakeSocket.last.deliver({ type: "queued" });
    vi.advanceTimersByTime(61_000);
    const actions = els.get("match-actions")!;
    expect(actions.hidden).toBe(false);
    els.get("match-stop")!.onclick!();
    expect(actions.hidden).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(els.get("match-waited")!.textContent).toBe("71");
  });

  it("shows a plain message when a signed-in player gets taken", () => {
    vi.useFakeTimers();
    FakeSocket.last.deliver({ type: "error", code: "taken" });
    expect(els.get("match-name-card")!.hidden).toBe(true);
    expect(els.get("match-error")!.textContent).toContain(
      "already waiting under your name",
    );
  });
});
