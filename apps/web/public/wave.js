// The clip's waveform follows the music: the clip is fetched a second time
// and decoded offline into loudness curves for three bands, and each frame
// sets the bars from the curves at the audio's current time. Playback never
// passes through Web Audio, because a connected <audio> goes silent while its
// context is suspended and iOS mutes Web Audio under the ringer switch. Until
// the curves exist, or when anything fails, the CSS animation stays.
(() => {
  const rate = 11025;
  const fps = 40;
  const bands = [
    { type: "lowpass", frequency: 220 },
    { type: "bandpass", frequency: 1000, Q: 0.8 },
    { type: "highpass", frequency: 3200 },
  ];
  const curves = new Map();
  const playable = (url) =>
    /^https?:/.test(url) && !url.endsWith("/silence.wav");

  // One loudness value per frame, scaled between this band's quiet floor
  // and its loud moments, so a beat reads as a jump rather than a wobble.
  function loudness(samples) {
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

  async function render(buffer, band) {
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

  // Keyed by the URL without its query: a re-signed link to the same clip
  // reuses the curves.
  function curvesFor(url) {
    const key = url.split("?")[0];
    if (!curves.has(key))
      curves.set(
        key,
        fetch(url, { mode: "cors", credentials: "omit" })
          .then((response) => {
            if (!response.ok) throw new Error(`clip ${response.status}`);
            return response.arrayBuffer();
          })
          .then((bytes) =>
            new OfflineAudioContext(1, rate, rate).decodeAudioData(bytes),
          )
          .then((buffer) =>
            Promise.all(bands.map((band) => render(buffer, band))),
          )
          .catch(() => null),
      );
    return curves.get(key);
  }

  window.clipWave = (audio, wave) => {
    if (!audio || !wave || !window.OfflineAudioContext) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bars = [...wave.children];
    const level = bars.map(() => 0);
    let current = null;
    let frame = 0;

    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      wave.classList.remove("is-following");
      for (const bar of bars) bar.style.transform = "";
    };

    // Low bands sit in the middle and high ones at the edges, like a
    // mirrored spectrum; each bar keeps a little of its fixed shape.
    const draw = () => {
      const shown = bars.filter((bar) => bar.offsetWidth > 0);
      const half = (shown.length - 1) / 2 || 1;
      const at = audio.currentTime * fps;
      const frames = current[0].length;
      shown.forEach((bar, i) => {
        // Both halves read the same moment, so the shape mirrors; the
        // edges trail the middle slightly, which reads as a ripple.
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
      const found = await curvesFor(url);
      if (!found || audio.paused || (audio.currentSrc || audio.src) !== url)
        return;
      current = found;
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
      if (playable(url)) curvesFor(url);
    });
  };
  window.clipWave.prefetch = (url) => {
    if (playable(url)) curvesFor(url);
  };
})();
