// Drives the solo clip's play/pause toggle and its fades against a round's
// markup, with a media element that plays as soon as it is asked.
import { beforeAll, describe, expect, it, vi } from "vitest";

const src = "https://cdn.example/clip.mp3";
let clip: HTMLAudioElement;
let paused = true;
const toggle = () => document.getElementById("clip-toggle")!;
const icon = () =>
  toggle().querySelector(".i-play")!.hasAttribute("hidden") ? "pause" : "play";
const frames = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  document.body.innerHTML = `
    <div id="game">
      <div id="round" data-phase="question" data-game="g1" data-src="${src}">
        <div class="player">
          <audio id="clip" src="${src}"></audio>
          <button id="clip-toggle" type="button">
            <svg class="i-play"></svg><svg class="i-pause"></svg>
          </button>
          <input id="clip-volume" type="range" />
        </div>
        <div id="count-bar"></div><span id="count-left"></span>
      </div>
    </div>`;
  clip = document.getElementById("clip") as HTMLAudioElement;
  Object.defineProperty(clip, "paused", { get: () => paused });
  Object.defineProperty(clip, "duration", { value: 30 });
  Object.defineProperty(clip, "currentTime", { value: 0, writable: true });
  clip.play = async () => {
    paused = false;
    clip.dispatchEvent(new Event("play"));
  };
  clip.pause = () => {
    paused = true;
    clip.dispatchEvent(new Event("pause"));
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject("offline")),
  );
  await import("./solo");
  await frames(0);
});

describe("the solo clip toggle", () => {
  it("plays the round's clip at the player's volume", () => {
    expect(paused).toBe(false);
    expect(clip.volume).toBe(0.6);
    expect(icon()).toBe("pause");
  });

  it("shows play the moment a pause starts its fade", () => {
    toggle().click();
    expect(icon()).toBe("play");
    expect(paused).toBe(false);
  });

  it("plays again at full volume on a tap during the fade", async () => {
    await frames(100);
    toggle().click();
    await frames(400);
    expect(paused).toBe(false);
    expect(clip.volume).toBe(0.6);
    expect(icon()).toBe("pause");
  });

  it("fades out once at the clip's end and keeps its volume", async () => {
    clip.currentTime = 29.5;
    for (let i = 0; i < 5; i += 1) {
      clip.dispatchEvent(new Event("timeupdate"));
      await frames(50);
    }
    await frames(800);
    expect(paused).toBe(true);
    expect(clip.volume).toBe(0.6);
  });

  it("starts over from the top when played after its end", async () => {
    toggle().click();
    await frames(0);
    expect(clip.currentTime).toBe(0);
    expect(paused).toBe(false);
    expect(clip.volume).toBe(0.6);
  });
});
