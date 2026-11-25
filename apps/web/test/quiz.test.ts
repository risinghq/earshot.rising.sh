import { describe, expect, it } from "vitest";
import {
  finaleOrder,
  finaleWindow,
  maxChoices,
  roundsPerGame,
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

describe("finaleOrder", () => {
  const known = (song: { title: string }) => Number(song.title.split(" ")[1]);

  it("moves the best-known early track to the last round", () => {
    const drawn = [5, 9, 2, 7, 8, 6, 4, 3, 1, 11, 12].map((n) =>
      entry(`Song ${n}`),
    );
    const order = finaleOrder(drawn, known).map((song) => song.title);
    expect(order[roundsPerGame - 1]).toBe("Song 1");
    expect(order.slice(0, roundsPerGame - 1)).toEqual(
      [5, 9, 2, 7, 8, 6, 4, 3, 11].map((n) => `Song ${n}`),
    );
    expect(order).toHaveLength(drawn.length);
  });

  it("leaves tracks past the window to later games", () => {
    const order = finaleOrder(titles(30).reverse(), known);
    expect(order[roundsPerGame - 1]!.title).toBe(`Song ${30 - finaleWindow}`);
  });

  it("ends a short game on its best-known track", () => {
    const drawn = [entry("Song 2"), entry("Song 0"), entry("Song 3")];
    expect(finaleOrder(drawn, known).map((song) => song.title)).toEqual([
      "Song 2",
      "Song 3",
      "Song 0",
    ]);
  });
});
