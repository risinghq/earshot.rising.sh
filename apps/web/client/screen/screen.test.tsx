// Drives the TV's panels with state messages, as the socket delivers them,
// and reads the DOM they draw.
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  RoomPlayer,
  RoomState,
  ServerMessage,
} from "../../src/play/room/protocol";
import { createScreen, type Screen as ScreenModel } from "./model";
import { Screen } from "./Screen";

const code = "ABCD23";
const player = (name: string, over: Partial<RoomPlayer> = {}): RoomPlayer => ({
  name,
  creator: false,
  user: false,
  score: 0,
  connected: true,
  answered: false,
  ...over,
});

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
    seats: 4,
    you: {
      name: "",
      creator: false,
      user: false,
      marks: [],
      streak: 0,
      answer: null,
    },
    players: [player("Ann", { creator: true }), player("Bo")],
    watch: true,
    ...over,
  };
}

let screen: ScreenModel;
let sent: ClientMessage[];
let closed: number;
let dispose: () => void;
const byId = (id: string) => document.getElementById(id)!;
const texts = (selector: string) =>
  [...document.querySelectorAll(selector)].map((el) => el.textContent);
const deliver = (message: ServerMessage) => {
  screen.receive(message);
  flush();
};

beforeEach(() => {
  sent = [];
  closed = 0;
  document.body.innerHTML = `
    <main id="screen" data-code="${code}">
      <template data-parts>
        <div data-part="mark"><svg class="sound-mark"></svg></div>
        <div data-part="join"><div class="tv-join"><svg class="tv-qr"></svg></div></div>
      </template>
    </main>
    <audio id="screen-clip"></audio>`;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  screen = createScreen({
    send: (message) => sent.push(message),
    close: () => closed++,
  });
  screen.attach(byId("screen-clip") as HTMLAudioElement);
  dispose = render(
    () => <Screen screen={screen} code={code} />,
    byId("screen"),
  );
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
});

describe("screen", () => {
  it("shows the lobby with the join code, the roster and the open seats", () => {
    deliver(base({}));
    expect(byId("screen-lobby").querySelector(".tv-qr")).not.toBeNull();
    expect(texts(".tv-code span").join("")).toBe(code);
    expect(texts("#screen-roster b")).toEqual([
      "Ann",
      "Bo",
      "Open seat",
      "Open seat",
    ]);
    expect(byId("screen-seats").textContent).toBe("2 of 4");
    expect(texts("#screen-lobby-hint > *")).toEqual([
      "A",
      "Waiting for Ann to start the game.",
    ]);
    expect(byId("screen-game").hidden).toBe(true);
  });

  it("reports the clip ready once per round and lists who answered", () => {
    const round = base({
      phase: "playing",
      round: 3,
      clip: "/clip.mp3",
      startedAt: Date.now() + 60_000,
      endsAt: Date.now() + 75_000,
      players: [player("Ann", { creator: true, answered: true }), player("Bo")],
    });
    deliver(round);
    deliver(round);
    byId("screen-clip").dispatchEvent(new Event("canplay"));
    byId("screen-clip").dispatchEvent(new Event("canplay"));
    expect(sent).toEqual([{ type: "loaded" }]);
    expect(byId("screen-game").hidden).toBe(false);
    expect(document.getElementById("screen-lobby")).toBeNull();
    expect(byId("screen-round-title").textContent).toBe("Round 3 of 10");
    expect(texts("#screen-answers small")).toEqual(["Answered", "Thinking…"]);
    expect(byId("screen-count").textContent).toBe("15");
    expect(byId("screen-worth").textContent).toBe("seconds · worth 1,000");
  });

  it("sorts the reveal by points and counts down to the results", () => {
    deliver(
      base({
        phase: "reveal",
        round: 10,
        players: [
          player("Ann", { creator: true, score: 900 }),
          player("Bo", { score: 2400 }),
        ],
        reveal: {
          number: 10,
          track: "t",
          title: "Song",
          original: "ソング",
          work: "Bubblegum Crisis · OP2",
          artist: "Artist",
          cover: null,
          link: null,
          until: Date.now() + 4_500,
          choices: [],
          results: [
            { name: "Ann", answer: null, correct: false, score: 0, streak: 0 },
            {
              name: "Bo",
              answer: "Song",
              correct: true,
              score: 800,
              streak: 2,
            },
          ],
        },
      }),
    );
    expect(byId("screen-reveal-artist").textContent).toBe("ソング · Artist");
    expect(texts(".tv-work")).toEqual(["Bubblegum Crisis · OP2"]);
    expect(texts("#screen-reveal-scores b")).toEqual(["Bo", "Ann"]);
    expect(texts("#screen-reveal-scores .tv-total")).toEqual(["2,400", "900"]);
    expect(byId("screen-next").textContent).toBe("results in 5 s");
  });

  it("names a tie and lists the standings from second place", () => {
    deliver(
      base({
        phase: "done",
        kind: "match",
        standings: [
          { name: "Ann", score: 5000, correct: 7 },
          { name: "Bo", score: 5000, correct: 6 },
          { name: "Cy", score: 100, correct: 1 },
        ],
      }),
    );
    expect(byId("screen-winner-label").textContent).toBe("Tied for first");
    expect(byId("screen-winner-correct").textContent).toBe("7/10 correct");
    expect(texts("#screen-standings .tv-rank")).toEqual(["2", "3"]);
    expect(byId("screen-final-hint").textContent).toBe(
      "Full results are on every phone.",
    );
  });

  it("closes when the room is gone", () => {
    deliver(base({}));
    deliver({ type: "error", code: "gone" });
    expect(closed).toBe(1);
    expect(document.getElementById("screen-lobby")).toBeNull();
    expect(byId("screen-game").hidden).toBe(true);
    expect(byId("screen-error").textContent).toBe(
      "This room has closed. Start a new one from the hub.",
    );
  });
});
