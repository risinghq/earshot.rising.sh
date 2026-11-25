// The clip's waveform follows the music: the clip is fetched a second time
// and decoded offline into loudness curves for three bands, and each frame
// sets the bars from the curves at the audio's current time. Playback never
// passes through Web Audio, because a connected <audio> goes silent while its
// context is suspended and iOS mutes Web Audio under the ringer switch. Until
// the curves exist, or when anything fails, the CSS animation stays. The same
// decode gives the clip's overall loudness, which level.ts levels clips by.
const rate = 11025;
const fps = 40;
type Band = { type: BiquadFilterType; frequency: number; Q?: number };
type Curves = Float32Array[];
type Analysis = { curves: Curves; loudness: number };

const bands: Band[] = [
  { type: "lowpass", frequency: 220 },
  { type: "bandpass", frequency: 1000, Q: 0.8 },
  { type: "highpass", frequency: 3200 },
];
const analyses = new Map<string, Promise<Analysis | null>>();
const playable = (url: string) =>
  /^https?:/.test(url) && !url.endsWith("/silence.wav");

// One loudness value per frame, scaled between this band's quiet floor and
// its loud moments, so a beat reads as a jump rather than a wobble.
function loudness(samples: Float32Array) {
  const step = Math.floor(rate / fps);
  const out = new Float32Array(Math.floor(samples.length / step));
  for (let f = 0; f < out.length; f += 1) {
    let sum = 0;
    for (let i = f * step; i < (f + 1) * step; i += 1)
      sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / step);
  }
  const sorted = [...out].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const top = sorted[Math.floor(sorted.length * 0.95)] || 1;
  const span = top - floor || 1;
  for (let f = 0; f < out.length; f += 1)
    out[f] = Math.max(0, Math.min(1.2, (out[f] - floor) / span));
  return out;
}

// Gated RMS of the mono downmix in dB, after EBU R 128: 400 ms blocks, with
// the blocks 10 dB under the mean dropped so a quiet intro does not pull a
// loud song down. On previews it reads within about 2 dB of integrated LUFS.
export function gatedLoudness(channels: Float32Array[], sampleRate: number) {
  const length = channels[0]?.length ?? 0;
  const block = Math.floor(sampleRate * 0.4);
  const hop = Math.floor(block / 4);
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + block; i += 1) {
      let v = 0;
      for (const data of channels) v += data[i];
      v /= channels.length;
      sum += v * v;
    }
    if (sum / block > 1e-7) powers.push(sum / block);
  }
  if (!powers.length) return null;
  const mean = powers.reduce((a, b) => a + b, 0) / powers.length;
  const loud = powers.filter((p) => p > mean * 0.1);
  return 10 * Math.log10(loud.reduce((a, b) => a + b, 0) / loud.length);
}

async function render(buffer: AudioBuffer, band: Band) {
  const context = new OfflineAudioContext(1, buffer.length, rate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = band.type;
  filter.frequency.value = band.frequency;
  if (band.Q) filter.Q.value = band.Q;
  source.connect(filter).connect(context.destination);
  source.start();
  return loudness((await context.startRendering()).getChannelData(0));
}

async function analyse(buffer: AudioBuffer): Promise<Analysis | null> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c),
  );
  const level = gatedLoudness(channels, buffer.sampleRate);
  if (level === null) return null;
  const curves = await Promise.all(bands.map((band) => render(buffer, band)));
  return { curves, loudness: level };
}

// Keyed by the URL without its query: a re-signed link to the same clip
// reuses the analysis.
function analysisFor(url: string): Promise<Analysis | null> {
  if (!globalThis.OfflineAudioContext) return Promise.resolve(null);
  const key = url.split("?")[0];
  let found = analyses.get(key);
  if (!found) {
    found = fetch(url, { mode: "cors", credentials: "omit" })
      .then((response) => {
        if (!response.ok) throw new Error(`clip ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) =>
        new OfflineAudioContext(1, rate, rate).decodeAudioData(bytes),
      )
      .then(analyse)
      .catch(() => null);
    analyses.set(key, found);
  }
  return found;
}

export async function clipLoudness(url: string) {
  if (!playable(url)) return null;
  return (await analysisFor(url))?.loudness ?? null;
}

export function clipWave(
  audio: HTMLAudioElement | null,
  wave: HTMLElement | null,
) {
  if (!audio || !wave || !globalThis.OfflineAudioContext) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const bars = [...wave.children] as HTMLElement[];
  const level = bars.map(() => 0);
  let current: Curves = [];
  let frame = 0;

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    wave.classList.remove("is-following");
    for (const bar of bars) bar.style.transform = "";
  };

  // Low bands sit in the middle and high ones at the edges, like a mirrored
  // spectrum; each bar keeps a little of its fixed shape.
  const draw = () => {
    const shown = bars.filter((bar) => bar.offsetWidth > 0);
    const half = (shown.length - 1) / 2 || 1;
    const at = audio.currentTime * fps;
    const frames = current[0].length;
    shown.forEach((bar, i) => {
      // Both halves read the same moment, so the shape mirrors; the edges
      // trail the middle slightly, which reads as a ripple.
      const p = Math.abs(i - half) / half;
      const f = Math.max(0, Math.floor(at - p * 6)) % frames;
      const v =
        (1 - p) ** 2 * current[0][f] +
        2 * p * (1 - p) * current[1][f] +
        p ** 2 * current[2][f];
      const shape = Number(bar.style.getPropertyValue("--s")) || 0.6;
      const target = Math.min(1, v * (0.8 + 0.5 * shape));
      const j = bars.indexOf(bar);
      level[j] += (target - level[j]) * (target > level[j] ? 0.6 : 0.18);
      bar.style.transform = `scaleY(${(0.12 + 0.88 * level[j]).toFixed(3)})`;
    });
    frame = requestAnimationFrame(draw);
  };

  const start = async () => {
    const url = audio.currentSrc || audio.src;
    if (!playable(url)) return stop();
    const found = await analysisFor(url);
    if (!found || audio.paused || (audio.currentSrc || audio.src) !== url)
      return;
    current = found.curves;
    wave.classList.add("is-following");
    if (frame === 0) frame = requestAnimationFrame(draw);
  };

  audio.addEventListener("playing", start);
  audio.addEventListener("pause", stop);
  audio.addEventListener("ended", stop);
  audio.addEventListener("emptied", stop);
  // Fetch while the clip loads, so the first sound already has curves.
  audio.addEventListener("loadstart", () => {
    const url = audio.currentSrc || audio.src;
    if (playable(url)) analysisFor(url);
  });
}

export function prefetchWave(url: string) {
  if (playable(url)) analysisFor(url);
}
