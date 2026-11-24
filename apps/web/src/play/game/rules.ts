// The game's rules and labels that the Worker and the browser scripts share.
// This module imports nothing, so a client bundle can take it whole.

export const roundSeconds = 15;
export const roundsPerGame = 10;
export const maxChoices = 4;

// Easy shows four titles with their artists, Normal four titles alone, and
// Hard asks for the title typed.
export const modes = ["easy", "normal", "hard"] as const;
export type Mode = (typeof modes)[number];
export const defaultMode: Mode = "easy";

export const modeNames: Record<Mode, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

export function parseMode(value: unknown): Mode | null {
  return modes.find((mode) => mode === value) ?? null;
}

export interface Choice {
  title: string;
  artist?: string;
}

// 1000 points at the clip's start, falling to 100 at its end, then nothing.
export function scoreFor(elapsedMs: number) {
  if (elapsedMs >= roundSeconds * 1000) return 0;
  return Math.round(1000 - (900 * elapsedMs) / (roundSeconds * 1000));
}

export const linkService = (link: string) =>
  link.includes("apple.com") ? "Apple Music" : "Deezer";

// A romanized title keeps its own script beside the artist.
export const byline = (song: { original?: string | null; artist: string }) =>
  song.original ? `${song.original} · ${song.artist}` : song.artist;

// "Bubblegum Crisis · OP2", or the show alone when the slot is unknown.
export const workLabel = (work: string | null, theme: string | null) =>
  work === null ? undefined : theme ? `${work} · ${theme}` : work;
