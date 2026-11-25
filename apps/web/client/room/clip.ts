// The round's <audio>. One element lives for the whole visit, so a phone
// that unlocked sound once keeps it for every round. Volume and mute hold
// across rounds and reloads; iOS ignores a volume the page sets, so there
// the slider stays hidden and a fade is a stop.
import { createSignal } from "solid-js";
import {
  canSetVolume,
  levelOf,
  measureClip,
  playerVolume,
  savePlayerVolume,
} from "../level";

const muteKey = "earshot-muted";

export function createClip(reducedMotion: boolean) {
  let volume = playerVolume();

  const [playing, setPlaying] = createSignal(false);
  const [muted, setMuted] = createSignal(localStorage.getItem(muteKey) === "1");
  const [unlocked, setUnlocked] = createSignal(false);
  const [needsClick, setNeedsClick] = createSignal(false);

  let audio: HTMLAudioElement | undefined;
  // The clip this round plays, kept apart from src while the silent unlock
  // file holds the element.
  let url: string | undefined;
  // The fade running bumps `fading`; `stopping` holds while one runs, and a
  // stopping clip counts as paused.
  let fading = 0;
  let stopping = false;
  let unlocking = false;
  // The round whose answers are open; a round that opens during the unlock
  // owns the clip.
  let roundOf = () => 0;

  // The level the round's clip plays at: the player's volume times its gain.
  const level = () => (url === undefined ? volume : levelOf(url, volume));

  const sync = () => {
    if (!audio) return;
    const on = !audio.paused && !audio.ended && !stopping;
    setPlaying(on);
    if (on) setNeedsClick(false);
  };

  function attach(element: HTMLAudioElement, openedRound: () => number) {
    audio = element;
    roundOf = openedRound;
    audio.volume = level();
    audio.muted = muted();
    for (const event of ["play", "playing", "pause", "ended"])
      audio.addEventListener(event, sync);
    // A clip never cuts off: it fades out once before its end.
    audio.addEventListener("timeupdate", () => {
      if (!audio || audio.paused || stopping) return;
      if (audio.duration - audio.currentTime < 0.8) fadeOut(700);
    });
  }

  function fadeOut(ms = 600) {
    if (!audio || audio.paused) return;
    const id = ++fading;
    const element = audio;
    if (!canSetVolume || reducedMotion) {
      element.pause();
      return;
    }
    stopping = true;
    sync();
    const from = element.volume;
    const t0 = performance.now();
    const step = (t: number) => {
      if (id !== fading) return;
      // A frame's timestamp can precede t0, which would push k below 0.
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      element.volume = from * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else {
        stopping = false;
        element.pause();
        element.volume = level();
      }
    };
    requestAnimationFrame(step);
  }

  function play() {
    if (!audio) return Promise.reject(new Error("no audio"));
    fading += 1;
    stopping = false;
    audio.volume = level();
    return audio.play();
  }

  // The round's clip, from its start or from where the room already is.
  function start(at: number) {
    if (!audio) return;
    if (at > 0.5 && audio.readyState >= 1) audio.currentTime = at;
    play().catch(() => setNeedsClick(true));
  }

  function load(next: string) {
    if (!audio || url === next) return;
    url = next;
    audio.src = next;
    measureClip(next).then(() => {
      if (audio && url === next && !stopping) audio.volume = level();
    });
  }

  // On a screened room the clip plays on the TV, never here.
  function clear() {
    if (!audio || url === undefined) return;
    fading += 1;
    stopping = false;
    audio.pause();
    audio.removeAttribute("src");
    url = undefined;
  }

  // Reports once the loaded clip can play through its start.
  function whenReady(report: () => void) {
    if (!audio || audio.readyState >= 3) report();
    else audio.addEventListener("canplay", report, { once: true });
  }

  // Browsers hold sound until the page gets a tap. The first tap anywhere
  // plays the element muted for a moment (a silent file when it has no clip
  // yet), which unlocks it for the rounds the socket starts later.
  function unlock() {
    if (!audio || unlocked() || unlocking) return;
    if (!audio.paused) {
      setUnlocked(true);
      return;
    }
    unlocking = true;
    const element = audio;
    const hadClip = element.getAttribute("src") !== null;
    const round = roundOf();
    if (!hadClip) element.src = "/silence.wav";
    element.muted = true;
    const settle = () => {
      unlocking = false;
      element.muted = muted();
      if (!hadClip) {
        if (url) element.src = url;
        else element.removeAttribute("src");
      }
    };
    element.play().then(() => {
      setUnlocked(true);
      if (roundOf() === round) {
        element.pause();
        if (hadClip) element.currentTime = 0;
      }
      settle();
    }, settle);
  }

  function toggle() {
    if (!audio) return;
    // A tap acts on what the player hears: a clip fading out plays again.
    if (audio.paused || stopping)
      play().then(
        () => setUnlocked(true),
        () => {},
      );
    else fadeOut(250);
  }

  function setVolume(percent: number) {
    volume = percent / 100;
    if (audio && !stopping) audio.volume = level();
    savePlayerVolume(percent);
  }

  function toggleMute() {
    const next = !muted();
    localStorage.setItem(muteKey, next ? "1" : "0");
    setMuted(next);
    if (audio) audio.muted = next;
  }

  return {
    attach,
    canSetVolume,
    volumePercent: () => Math.round(volume * 100),
    playing,
    muted,
    unlocked,
    needsClick,
    fadeOut,
    start,
    load,
    clear,
    whenReady,
    unlock,
    toggle,
    setVolume,
    toggleMute,
  };
}

export type Clip = ReturnType<typeof createClip>;
