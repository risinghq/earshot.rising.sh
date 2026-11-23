// Drives the room's views with state messages, as the socket delivers them,
// and reads the DOM they draw.
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  RoomPlayer,
  RoomState,
  ServerMessage,
} from "../../src/play/protocol";
import { createClip } from "./clip";
import { createRoom, type Room as RoomModel } from "./model";
import { createPicker } from "./picker";
import { Room } from "./Room";

const code = "ABCD23";
const ann: RoomPlayer = {
  name: "Ann",
  creator: true,
  user: true,
  score: 0,
  connected: true,
  answered: false,
};

function base(over: Partial<RoomState>): RoomState {
  return {
    type: "state",
    kind: "room",
    code,
    category: "Pop",
    categorySlug: "pop",
    mode: "easy",
    phase: "lobby",
    now: Date.now(),
    rounds: 10,
    seats: 8,
    you: {
      name: "Ann",
      creator: true,
      user: true,
      marks: [],
      streak: 0,
      answer: null,
    },
    players: [ann],
    ...over,
  };
}

const choices = [
  { title: "Song", artist: "Artist" },
  { title: "Other", artist: "Band" },
  { title: "Third", artist: "Trio" },
  { title: "Fourth", artist: "Duo" },
];

const playing = (round: number) =>
  base({
    phase: "playing",
    round,
    startedAt: Date.now() - 1000,
    endsAt: Date.now() + 14000,
    choices,
  });

const reveal = (number: number, track: string) =>
  base({
    phase: "reveal",
    round: number,
    reveal: {
      number,
      track,
      title: "Song",
      artist: "Artist",
      original: null,
      cover: null,
      link: null,
      until: Date.now() + 5000,
      choices,
      results: [],
    },
  });

let room: RoomModel;
let sent: ClientMessage[];
let dispose: () => void;
const byId = (id: string) => document.getElementById(id)!;
const deliver = (message: ServerMessage) => {
  room.receive(message);
  flush();
};

beforeEach(() => {
  sent = [];
  document.body.innerHTML = `<div id="game" class="room" data-code="${code}"></div>`;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  room = createRoom({
    code,
    signedIn: true,
    clip: createClip(true),
    send: (message) => sent.push(message),
    stop: () => {},
    close: () => {},
    reopen: () => {},
    post: async () => new Response(null),
  });
  const picker = createPicker(async () => ({}));
  dispose = render(
    () => <Room room={room} picker={picker} boardDays="15" />,
    byId("game"),
  );
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
});

describe("room round", () => {
  it("fills the choices when the round opens and locks a pick in", () => {
    deliver(playing(1));
    const buttons = [...byId("choices").querySelectorAll("button")];
    expect(
      buttons.map((b) => b.querySelector(".choice-title")?.textContent),
    ).toEqual(["Song", "Other", "Third", "Fourth"]);
    buttons[1].click();
    flush();
    expect(sent).toContainEqual({ type: "answer", answer: "Other" });
    expect(buttons[1].classList.contains("is-picked")).toBe(true);
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it("builds the now-playing card once per round, so an open report stays open", () => {
    deliver(reveal(1, "dz:1"));
    const card = byId("round").querySelector(".now")!;
    const report = card.querySelector("details")!;
    report.open = true;
    deliver(reveal(1, "dz:1"));
    expect(byId("round").querySelector(".now")).toBe(card);
    expect(report.open).toBe(true);
    deliver(playing(2));
    deliver(reveal(2, "dz:2"));
    expect(byId("round").querySelector(".now")).not.toBe(card);
  });

  it("heads the final reveal's card with the verdict and the results", () => {
    deliver(reveal(10, "dz:10"));
    expect(byId("verdict-word").textContent).toBe("Time ran out");
    expect(byId("room-slot").dataset.v).toBe("late");
    expect(byId("slot-note").textContent).toBe(
      "The results come when the bar above fills.",
    );
  });

  it("announces the verdict in a live region that is there before it", () => {
    deliver(playing(1));
    const region = byId("room-verdict");
    expect(region.getAttribute("aria-live")).toBe("polite");
    deliver(reveal(1, "dz:1"));
    expect(byId("room-verdict")).toBe(region);
    expect(region.querySelector("#verdict-word")?.textContent).toBeTruthy();
  });

  it("shows the failure hint when the report is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );
    deliver(reveal(3, "dz:3"));
    const form = byId("round").querySelector<HTMLFormElement>(".report-form")!;
    form.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flush();
    expect(form.textContent).toContain("Could not send the report.");
    vi.unstubAllGlobals();
  });

  it("shows the away screen once the seat moves to another device", () => {
    deliver(playing(1));
    deliver({ type: "moved" });
    expect(byId("away-panel").hidden).toBe(false);
    expect(byId("round").hidden).toBe(true);
  });
});
