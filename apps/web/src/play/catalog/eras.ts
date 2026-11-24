// A catalog era is a decade (1990, 2000, ...) or, for K-pop, a generation.
// K-pop fans place an act by the generation it debuted in, not by the year
// of a song, so the K-pop catalog keys its eras by each generation's first
// year. No such year is a multiple of ten, so the two kinds never collide.
export const generations: Record<number, string> = {
  1996: "1st gen",
  2004: "2nd gen",
  2012: "3rd gen",
  2018: "4th gen",
  2023: "5th gen",
};

export const isGeneration = (era: number) => era in generations;

// "90s" for a decade, "3rd gen" for a generation.
export const eraLabel = (era: number) =>
  generations[era] ?? `${String(era).slice(2)}s`;

// "1990s" or "3rd gen", where there is room for the whole decade.
export const eraName = (era: number) => generations[era] ?? `${era}s`;

// "4 decades" or "5 generations", for a set of one kind.
export const erasCount = (eras: number[]) =>
  `${eras.length} ${eras.every(isGeneration) ? "generations" : "decades"}`;
