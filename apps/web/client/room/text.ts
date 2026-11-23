// The room's words and numbers: pure functions of the room state, so the
// components only place them.
import type { Reveal, RoomState, UpNext } from "../../src/play/protocol";
import { modeNames, type Mode } from "../../src/play/rules";

export const number = (value: number) => value.toLocaleString("en-US");

export const ordinal = (n: number) =>
  n +
  (["th", "st", "nd", "rd"][
    (n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10
  ] ?? "th");

export const modeLabels: Record<Mode, string> = {
  easy: "Easy · titles with artists",
  normal: "Normal · titles only",
  hard: "Hard · type the title",
};

// "a", "a and b", "a, b and c".
export const names = (list: string[]) =>
  list.length < 2
    ? list.join("")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export const host = (s: RoomState) => s.players.find((p) => p.creator)?.name;
export const me = (s: RoomState) =>
  s.players.find((p) => p.name === s.you.name);

// "Ana, Ben and 3 more are in · 5 of 8".
export function whoIsIn(people: string[], seats: number) {
  const shown =
    people.length > 3
      ? [...people.slice(0, 2), `${people.length - 2} more`]
      : people;
  return `${names(shown)} ${people.length === 1 ? "is" : "are"} in · ${people.length} of ${seats}`;
}

// "3 suggestions · 2 of 4 voted". A player holds one vote, so the votes
// are the voters.
export function suggestionCount(s: RoomState) {
  const list = s.suggestions ?? [];
  if (list.length === 0) return "No suggestions yet";
  const voters = list.reduce((sum, x) => sum + x.votes, 0);
  return `${plural(list.length, "suggestion", "suggestions")} · ${voters} of ${s.players.length} voted`;
}

// The suggestion the host's main button plays: the first, once it holds a
// vote.
export const topPick = (s: RoomState): UpNext | undefined => {
  const first = s.suggestions?.[0];
  return first && first.votes > 0 ? first : undefined;
};

export const kindOf = (slug: string) =>
  slug.startsWith("artist-") ? "Artist" : "Genre";

export const suggestionLine = (x: UpNext) =>
  `${kindOf(x.slug)} · ${modeNames[x.mode]}${x.by ? ` · ${x.mine ? "you" : x.by}` : ""}`;

export type Verdict = "right" | "wrong" | "late";

export const mineOf = (s: RoomState, r: Reveal) =>
  r.results.find((result) => result.name === s.you.name);

export function verdictOf(s: RoomState, r: Reveal): Verdict {
  const mine = mineOf(s, r);
  return mine?.correct ? "right" : mine?.answer ? "wrong" : "late";
}

export const verdictWords: Record<Verdict, string> = {
  right: "Nailed it!",
  wrong: "Not quite",
  late: "Time ran out",
};

// "2nd of 4 overall", or nothing alone.
export function placeLine(s: RoomState) {
  if (s.players.length < 2) return "";
  const score = me(s)?.score ?? 0;
  const place = 1 + s.players.filter((p) => p.score > score).length;
  return `${ordinal(place)} of ${s.players.length} overall`;
}

// A right answer's score falls with time, so the order of the right
// answers' scores is the order they came in.
export function revealNote(s: RoomState, r: Reveal) {
  const mine = mineOf(s, r);
  const right = r.results.filter((result) => result.correct);
  const speed =
    mine?.correct && right.length > 1
      ? 1 + right.filter((result) => result.score > mine.score).length
      : 0;
  const fastest =
    speed === 1
      ? "You were the fastest. "
      : speed > 1
        ? `You were ${ordinal(speed)} fastest. `
        : "";
  const next = r.number >= s.rounds ? "The results come" : "Next round";
  return `${fastest}${next} when the bar above fills.`;
}

// The final card's summary of this player's game.
export function doneSummary(s: RoomState) {
  const marks = s.you.marks;
  const standings = s.standings ?? [];
  const score = me(s)?.score ?? 0;
  const place = 1 + standings.filter((p) => p.score > score).length;
  const many = standings.length > 1;
  const winner = standings[0];
  const tied = many && standings[1].score === winner.score;
  let best = 0;
  let run = 0;
  for (const right of marks) {
    run = right ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const right = marks.filter(Boolean).length;
  const rank = !many
    ? s.category
    : tied
      ? `Tied for first with ${number(winner.score)}`
      : winner.name === s.you.name
        ? `You won with ${number(winner.score)}`
        : `${winner.name} won with ${number(winner.score)}`;
  const boardRank =
    1 + (s.board ?? []).filter((entry) => entry.score > score).length;
  const won = many && !tied && winner.name === s.you.name;
  const save = won
    ? "You beat the room. Keep the win"
    : boardRank <= 10
      ? `That's #${boardRank} on ${s.category}`
      : `Keep your ${number(score)} points`;
  return {
    score,
    many,
    rank,
    place: `${ordinal(place)} of ${standings.length}`,
    pips: `${right} of ${marks.length} right`,
    stats: [
      ["Correct", `${right}/${marks.length}`],
      ["Best streak", String(best)],
      ["Place", many ? ordinal(place) : "—"],
    ] as const,
    save,
  };
}

// "nobody got it", "everyone got it", "you, Ana got it".
export function gotItLine(
  got: string[],
  everyone: number,
  you: string,
): string {
  if (got.length === 0) return "nobody got it";
  if (got.length === everyone) return "everyone got it";
  return `${got.map((name) => (name === you ? "you" : name)).join(", ")} got it`;
}

export const pickTitles = {
  suggest: "Suggest next game",
  next: "Pick next game",
  set: "Change category",
} as const;
export type PickPurpose = keyof typeof pickTitles;

export function pickButton(
  purpose: PickPurpose,
  tab: "genre" | "artist",
  choice: string | null,
  mode: Mode,
) {
  if (choice === null)
    return tab === "artist" ? "Search and pick an artist" : "Pick a genre";
  const verb =
    purpose === "suggest" ? "Suggest" : purpose === "next" ? "Play" : "Set";
  return `${verb} ${choice} · ${modeNames[mode]}`;
}

export const joinErrors = {
  name: "Pick a nickname of 1 to 20 characters.",
  taken: "That nickname is taken in this room.",
};
