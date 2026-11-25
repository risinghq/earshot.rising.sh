// How loud a clip plays: the player's volume times the clip's own gain.
// Previews come mastered far apart (an iTunes ballad sits about 11 dB under a
// Deezer pop preview), so each clip is measured once and brought toward one
// reference level. An element's volume cannot pass 1, so a quiet clip gains
// only the headroom the player's volume leaves. iOS ignores a volume the page
// sets, so there neither the slider nor the levelling applies.
import { clipLoudness } from "./wave";

const volumeKey = "earshot-volume";
// Gated RMS of the mono downmix, in dB; a typical pop master measures about
// -7 and a quiet ballad about -17.
const referenceDb = -10;
const minGain = 0.3;
const maxGain = 3;

const probe = document.createElement("audio");
probe.volume = 0.5;
export const canSetVolume = probe.volume !== 1;

export function playerVolume() {
  const saved = localStorage.getItem(volumeKey);
  return saved === null ? 0.6 : Number(saved) / 100;
}

export function savePlayerVolume(percent: number) {
  localStorage.setItem(volumeKey, String(percent));
}

const gains = new Map<string, number>();
const keyOf = (url: string) => url.split("?")[0];

// The level for a clip at a given player volume. A clip not yet measured
// plays at the plain volume.
export function levelOf(url: string, volume = playerVolume()) {
  return Math.min(1, volume * (gains.get(keyOf(url)) ?? 1));
}

// Resolves once the clip's gain is known, so the caller can set its level.
export async function measureClip(url: string) {
  const key = keyOf(url);
  if (gains.has(key)) return;
  const db = await clipLoudness(url);
  if (db === null) return;
  const gain = 10 ** ((referenceDb - db) / 20);
  gains.set(key, Math.min(maxGain, Math.max(minGain, gain)));
}
