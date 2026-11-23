// Visual values the server pages and the browser scripts must compute the
// same way. This module imports nothing, so a client bundle can take it.

// The design's name hash: the same name always gets the same hue, so a
// person keeps one colour on every board, list and group.
export function hueOf(text: string) {
  return [...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
}

// The waveform's bars: fixed heights and timings, so every round draws the
// same shape. The phone shows the first 34.
export const waveBars = Array.from({ length: 46 }, (_, i) => {
  const scale = 0.3 + 0.7 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45));
  const duration = 0.45 + ((i * 37) % 45) / 100;
  return `--s:${scale.toFixed(2)};--d:${duration.toFixed(2)}s;--delay:${(-i * 0.13).toFixed(2)}s`;
});
