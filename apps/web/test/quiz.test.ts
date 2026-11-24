import { describe, expect, it } from "vitest";
import {
  maxChoices,
  sampleChoices,
  upcomingTitles,
} from "../src/play/game/quiz";

const entry = (title: string) => ({ title, artist: `${title} artist` });
const titles = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(`Song ${i}`));

describe("sampleChoices", () => {
  it("never offers a title to avoid while other titles remain", () => {
    const pool = titles(12);
    const answer = pool[0]!;
    const avoid = pool.slice(1, 9).map((song) => song.title);
    for (let run = 0; run < 50; run++) {
      const offered = sampleChoices("normal", pool, answer, avoid).map(
        (choice) => choice.title,
      );
      expect(offered).toContain(answer.title);
      expect(offered.filter((title) => avoid.includes(title))).toEqual([]);
    }
  });

  it("falls back to avoided titles when the pool has no others", () => {
    const pool = titles(4);
    const offered = sampleChoices(
      "normal",
      pool,
      pool[0]!,
      pool.map((song) => song.title),
    );
    expect(offered).toHaveLength(maxChoices);
  });

  it("does not offer two titles that differ only by a feat. credit", () => {
    const pool = [entry("Halo"), entry("Halo (feat. Someone)"), entry("Other")];
    const offered = sampleChoices("normal", pool, pool[0]!).map(
      (choice) => choice.title,
    );
    expect(offered).toEqual(expect.arrayContaining(["Halo", "Other"]));
    expect(offered).not.toContain("Halo (feat. Someone)");
  });
});

describe("upcomingTitles", () => {
  it("lists the titles after the one being served, one game long", () => {
    const pool = titles(30);
    const next = upcomingTitles(pool, 4);
    expect(next[0]).toBe("Song 5");
    expect(next).not.toContain("Song 4");
    expect(next).toHaveLength(9);
  });
});
