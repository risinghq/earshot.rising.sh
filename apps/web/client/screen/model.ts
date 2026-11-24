// The TV's state: the room snapshot it watches, the round's clock and the
// clip it plays. The phones answer; the screen only shows and plays.
import { createSignal } from "solid-js";
import type {
  ClientMessage,
  RoomState,
  ServerMessage,
} from "../../src/play/room/protocol";
import { roundSeconds } from "../../src/play/game/rules";
import { clipWave } from "../wave";

export const roundMs = roundSeconds * 1000;
// The worth falls 60 points a second; a slower redraw moves it in visible,
// uneven jumps.
const tickMs = 50;

export function createScreen(socket: {
  send: (message: ClientMessage) => void;
  close: () => void;
}) {
  const send = socket.send;
  const [state, setState] = createSignal<RoomState | null>(null);
  const [error, setError] = createSignal("");
  const [gone, setGone] = createSignal(false);
  const [left, setLeft] = createSignal(roundMs);
  const [nextIn, setNextIn] = createSignal(0);
  const [live, setLive] = createSignal(false);
  const [askSound, setAskSound] = createSignal(false);

  let offset = 0; // server time minus local time
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let nextTimer: ReturnType<typeof setInterval> | undefined;
  let playTimer: ReturnType<typeof setTimeout> | undefined;
  let loadedFor = 0; // the round number this screen last reported ready
  let audio: HTMLAudioElement | undefined;
  let playing: string | undefined; // the clip URL the element holds
  let wantsSound = false;
  let blocked = false;

  const serverNow = () => Date.now() + offset;

  // Browsers hold sound until the page gets a click. In the lobby the
  // button asks for that click ahead of time; in a round it shows when a
  // play was blocked. Once the page has had a click, Chrome and Firefox let
  // every later clip play.
  const activated = () =>
    (
      navigator as Navigator & {
        getAutoplayPolicy?: (type: string) => string;
      }
    ).getAutoplayPolicy?.("mediaelement") === "allowed" ||
    navigator.userActivation?.hasBeenActive === true;
  function syncSound() {
    const lobby = state()?.phase === "lobby" && !gone() && !activated();
    const stuck = wantsSound && blocked && audio?.paused === true;
    setAskSound(lobby || stuck);
  }

  // The page's <audio>, which the server renders outside the app.
  function attach(el: HTMLAudioElement) {
    audio = el;
    el.addEventListener("playing", () => {
      blocked = false;
      setLive(true);
      syncSound();
    });
    el.addEventListener("pause", () => setLive(false));
    // A clip never cuts off at its end either.
    el.addEventListener("timeupdate", () => {
      if (el.duration - el.currentTime < 0.8) stopClip();
    });
    document.addEventListener("pointerdown", () => setTimeout(syncSound));
  }

  // The round's bars, which move with the clip.
  const wave = (el: HTMLElement) => clipWave(audio ?? null, el);

  function unlock() {
    if (wantsSound) audio?.play().catch(() => {});
    else syncSound();
  }

  // The clip fades out over 600 ms rather than cutting off, then lets go of
  // its source. A new clip arriving meanwhile cancels the fade.
  function stopClip() {
    clearTimeout(playTimer);
    const media = audio;
    if (!media) return;
    const url = playing;
    playing = undefined;
    const release = () => {
      if (playing !== undefined) return;
      media.pause();
      media.removeAttribute("src");
      media.load();
    };
    if (media.paused || url === undefined) {
      release();
      return;
    }
    const from = media.volume;
    const t0 = performance.now();
    const step = (t: number) => {
      if (playing !== undefined) {
        media.volume = from;
        return;
      }
      // A frame's timestamp can precede t0, which would push k below 0.
      const k = Math.min(1, Math.max(0, (t - t0) / 600));
      media.volume = from * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else {
        release();
        media.volume = from;
      }
    };
    requestAnimationFrame(step);
  }

  function close(text: string) {
    setGone(true);
    stopClip();
    wantsSound = false;
    clearInterval(tickTimer);
    clearInterval(nextTimer);
    setError(text);
    syncSound();
  }

  function receive(message: ServerMessage) {
    if (message.type === "error") {
      if (message.code === "gone") {
        close("This room has closed. Start a new one from the hub.");
        socket.close();
      } else setError("Something went wrong.");
      return;
    }
    if (message.type === "state") show(message);
  }

  function show(s: RoomState) {
    setError("");
    offset = s.now - Date.now();
    // The clip plays through its round's reveal and the final standings, so
    // the room hears the rest of the song; the lobby and the next load
    // silence it.
    if (s.phase !== "playing" && s.phase !== "reveal" && s.phase !== "done") {
      stopClip();
      wantsSound = false;
      blocked = false;
    }
    clearInterval(tickTimer);
    clearInterval(nextTimer);
    setState(s);
    if (s.phase === "loading" || s.phase === "playing") round(s);
    if (s.phase === "reveal") reveal(s);
    syncSound();
  }

  function round(s: RoomState) {
    const media = audio;
    const live = s.phase === "playing";
    if (live && s.clip && media && playing !== s.clip) {
      playing = s.clip;
      media.src = s.clip;
    }
    // Like the phones, the screen tells the room once the clip can play;
    // the round starts on the last report or the server's timeout.
    if (live && s.round !== loadedFor) {
      loadedFor = s.round ?? 0;
      if (!s.clip || !media) send({ type: "loaded" });
      else
        media.addEventListener("canplay", () => send({ type: "loaded" }), {
          once: true,
        });
    }
    if (live && s.clip && media && s.startedAt !== undefined) {
      wantsSound = true;
      // The clip starts on the server's stamp, the same moment the players'
      // phones open their answers, so speed points stay fair.
      const begin = () => {
        media.play().catch(() => {
          blocked = true;
          syncSound();
        });
      };
      const delay = s.startedAt - serverNow();
      clearTimeout(playTimer);
      if (delay > 0) playTimer = setTimeout(begin, delay);
      else begin();
    }
    const tick = () => {
      const ms =
        live && s.endsAt !== undefined
          ? Math.max(0, Math.min(roundMs, s.endsAt - serverNow()))
          : roundMs;
      setLeft(ms);
      if (ms <= 0) clearInterval(tickTimer);
    };
    tick();
    if (live) tickTimer = setInterval(tick, tickMs);
  }

  function reveal(s: RoomState) {
    const until = s.reveal?.until ?? 0;
    const next = () =>
      setNextIn(Math.ceil(Math.max(0, until - serverNow()) / 1000));
    next();
    nextTimer = setInterval(next, 250);
  }

  return {
    state,
    error,
    gone,
    left,
    nextIn,
    live,
    askSound,
    attach,
    wave,
    unlock,
    receive,
    close,
  };
}

export type Screen = ReturnType<typeof createScreen>;
