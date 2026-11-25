import { describe, expect, it } from "vitest";
import { gatedLoudness } from "./wave";

const rate = 11025;
const tone = (amplitude: number, seconds: number) =>
  Float32Array.from(
    { length: rate * seconds },
    (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / rate),
  );
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("a clip's loudness", () => {
  it("reads a steady tone as its RMS in dB", () => {
    // A sine of amplitude 0.5 has RMS 0.5/√2, about -9 dB.
    const db = gatedLoudness([tone(0.5, 5)], rate)!;
    expect(db).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
  });

  it("ignores a quiet intro before a loud song", () => {
    const loud = gatedLoudness([tone(0.5, 20)], rate)!;
    const withIntro = gatedLoudness(
      [join(tone(0.01, 5), tone(0.5, 20))],
      rate,
    )!;
    expect(withIntro).toBeCloseTo(loud, 1);
  });

  it("has none for silence", () => {
    expect(gatedLoudness([new Float32Array(rate * 3)], rate)).toBeNull();
  });
});
