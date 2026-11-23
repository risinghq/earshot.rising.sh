// The round's <audio>. One element lives for the whole visit, so a phone
// that unlocked sound once keeps it for every round. Volume and mute hold
// across rounds and reloads; iOS ignores a volume the page sets, so there
// the slider stays hidden and a fade is a stop.
import { createSignal } from "solid-js";

const volumeKey = "earshot-volume";
const muteKey = "earshot-muted";

export function createClip(reducedMotion: boolean) {
  const probe = document.createElement("audio");
  probe.volume = 0.5;
  const canSetVolume = probe.volume !== 1;
  const saved = localStorage.getItem(volumeKey);
  let volume = saved === null ? 0.6 : Number(saved) / 100;

  const [playing, setPlaying] = createSignal(false);
  const [muted, setMuted] = createSignal(localStorage.getItem(muteKey) === "1");
  const [unlocked, setUnlocked] = createSignal(false);
  const [needsClick, setNeedsClick] = createSignal(false);

  let audio: HTMLAudioElement | undefined;
  // The clip this round plays, kept apart from src while the silent unlock
  // file holds the element.
  let url: string | undefined;
  let fading = 0;
  let unlocking = false;
  // The round whose answers are open; a round that opens during the unlock
  // owns the clip.
  let roundOf = () => 0;

  const sync = () => {
    if (!audio) return;
    const on = !audio.paused && !audio.ended;
    setPlaying(on);
    if (on) setNeedsClick(false);
  };

  function attach(element: HTMLAudioElement, openedRound: () => number) {
    audio = element;
    roundOf = openedRound;
    audio.volume = volume;
    audio.muted = muted();
    for (const event of ["play", "playing", "pause", "ended"])
      audio.addEventListener(event, sync);
    // A clip never cuts off: it fades out before its end.
    audio.addEventListener("timeupdate", () => {
      if (audio && audio.duration - audio.currentTime < 0.8 && !audio.paused)
        fadeOut(700);
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
    const t0 = performance.now();
    const step = (t: number) => {
      if (id !== fading) return;
      // A frame's timestamp can precede t0, which would push k below 0.
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      element.volume = volume * (1 - k);
      if (k < 1) requestAnimationFrame(step);
      else {
        element.pause();
        element.volume = volume;
      }
    };
    requestAnimationFrame(step);
  }

  function play() {
    if (!audio) return Promise.reject(new Error("no audio"));
    fading += 1;
    audio.volume = volume;
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
  }

  // On a screened room the clip plays on the TV, never here.
  function clear() {
    if (!audio || url === undefined) return;
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
    if (audio.paused)
      play().then(
        () => setUnlocked(true),
        () => {},
      );
    else fadeOut(250);
  }

  function setVolume(percent: number) {
    volume = percent / 100;
    if (audio) audio.volume = volume;
    localStorage.setItem(volumeKey, String(percent));
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
