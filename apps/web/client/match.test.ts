// Drives the match page with matchmaker messages, as its socket delivers
// them, and reads the cards it shows.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MatchServerMessage } from "../src/play/protocol";

class FakeSocket {
  static last: FakeSocket;
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
  deliver(message: MatchServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const byId = (id: string) => document.getElementById(id)!;

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="match" data-category="pop" data-signed-in="1">
      <p id="match-error" hidden></p>
      <section id="match-name-card" hidden>
        <form id="match-name-form"><input id="match-nickname"></form>
      </section>
      <section id="match-search-card" hidden>
        <p id="match-status"></p><span id="match-waited"></span>
        <div id="match-actions" hidden><button id="match-stop"></button></div>
      </section>
    </div>`;
  vi.stubGlobal("WebSocket", FakeSocket);
  await import("./match");
  await Promise.resolve();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("match page", () => {
  it("joins the queue for the page's category as soon as the socket opens", () => {
    expect(FakeSocket.last.url).toMatch(/\/play\/match\/pop\/ws$/);
    expect(FakeSocket.last.sent).toEqual([JSON.stringify({ type: "join" })]);
  });

  it("keeps the waited counter counting after Keep waiting", () => {
    vi.useFakeTimers();
    FakeSocket.last.deliver({ type: "queued" });
    vi.advanceTimersByTime(61_000);
    expect(byId("match-actions").hidden).toBe(false);
    byId("match-stop").click();
    expect(byId("match-actions").hidden).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(byId("match-waited").textContent).toBe("71");
  });

  it("shows a plain message when a signed-in player gets taken", () => {
    FakeSocket.last.deliver({ type: "error", code: "taken" });
    expect(byId("match-name-card").hidden).toBe(true);
    expect(byId("match-error").textContent).toContain(
      "already waiting under your name",
    );
  });
});
