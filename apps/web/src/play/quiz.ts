import { normalizeText } from "../normalize";
import {
  deezerIsrcPreview,
  deezerPreview,
  deezerSearchPreview,
  QuotaError,
  type Candidate,
  type Preview,
} from "./sources";
import { maxChoices, roundsPerGame, type Choice, type Mode } from "./rules";

export {
  defaultMode,
  maxChoices,
  modes,
  parseMode,
  roundSeconds,
  roundsPerGame,
  scoreFor,
  type Choice,
  type Mode,
} from "./rules";

export interface PoolEntry {
  title: string;
  artist: string;
}

// One entry per title, so two tracks of one name never share a round.
export function poolOf(tracks: PoolEntry[]): PoolEntry[] {
  const seen = new Map<string, PoolEntry>();
  for (const { title, artist } of tracks)
    if (!seen.has(title)) seen.set(title, { title, artist });
  return [...seen.values()];
}

export function shuffled<T>(items: T[]): T[] {
  const order = crypto.getRandomValues(new Uint32Array(items.length));
  return items
    .map((item, i) => ({ item, sort: order[i] }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
}

// Resolves the clip for one candidate: a stored preview, then the Deezer id,
// then the ISRC lookup, then an artist-checked search. QuotaError propagates
// so the caller can hold the round instead of skipping the track.
export async function candidatePreview(
  candidate: Candidate,
): Promise<Preview | null> {
  if (candidate.preview)
    return {
      url: candidate.preview,
      link: candidate.link,
      cover: candidate.cover,
    };
  if (candidate.deezerId !== undefined)
    return deezerPreview(candidate.deezerId);
  if (candidate.isrc) {
    const byIsrc = await deezerIsrcPreview(
      candidate.isrc,
      candidate.artist,
    ).catch((error) => {
      if (error instanceof QuotaError) throw error;
      return null;
    });
    if (byIsrc) return byIsrc;
  }
  return deezerSearchPreview(candidate.artist, candidate.title);
}

// The titles the next rounds are likely to ask, from the candidate after the
// one being served. Skipped candidates shift this by a few at most.
export function upcomingTitles(candidates: PoolEntry[], index: number) {
  return candidates
    .slice(index + 1, index + roundsPerGame)
    .map((candidate) => candidate.title);
}

function levenshtein(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

const versionWords =
  "remix|mix|ver|version|edit|live|instrumental|inst|acoustic|remaster|remastered|sped up|slowed";
const versionBracket = new RegExp(
  `[[(][^\\])]*\\b(?:${versionWords})\\b[^\\])]*[\\])]`,
  "i",
);
const versionDash = new RegExp(
  `\\s[-–—]\\s.*\\b(?:${versionWords})\\b.*$`,
  "i",
);

// Bracketed clauses, a feat. credit and a dashed version clause
// ("- Extended ver.") are part of a title on a service but not of the name a
// player remembers.
export function answerKey(text: string) {
  const stripped = text
    .replace(versionDash, "")
    .replace(/[[(][^\])]*[\])]/g, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, "");
  return normalizeText(stripped);
}

// A remix, live cut, instrumental or language version of a song.
export function isVersion(title: string) {
  return versionBracket.test(title) || versionDash.test(title);
}

function matchesTitle(given: string, title: string) {
  const wanted = answerKey(title);
  if (wanted === "") return false;
  if (given === wanted) return true;
  // One edit in a title of two or three characters (most kanji and hangul
  // titles) leaves too little of the answer, so short titles must be exact.
  const limit = wanted.length >= 10 ? 2 : wanted.length >= 4 ? 1 : 0;
  return levenshtein(given, wanted) <= limit;
}

// A track with a romanized title also accepts its title in its own script.
export function matchTyped(
  input: string,
  track: { title: string; original?: string },
) {
  const given = answerKey(input);
  if (given === "") return false;
  return [track.title, track.original].some(
    (title) => title !== undefined && matchesTitle(given, title),
  );
}

// The distractor set is sampled once per round: re-sampling would let a
// reload narrow the answer to the title present in both lists.
// Normal sends no artist, so the page cannot leak the hint it hides.
// Titles to avoid (the ones the game already showed, and the answers of the
// rounds still to come) are used only when the pool runs out of others, so a
// wrong option does not come back round after round or give away a later
// answer.
export function sampleChoices(
  mode: Mode,
  pool: PoolEntry[],
  answer: PoolEntry,
  avoid: Iterable<string> = [],
): Choice[] {
  if (mode === "hard") return [];
  const seen = new Set([...avoid].map(answerKey));
  const keys = new Set([answerKey(answer.title)]);
  const distractors: PoolEntry[] = [];
  const others = shuffled(pool);
  const fresh = others.filter((entry) => !seen.has(answerKey(entry.title)));
  const stale = others.filter((entry) => seen.has(answerKey(entry.title)));
  for (const entry of [...fresh, ...stale]) {
    if (distractors.length === maxChoices - 1) break;
    // Two titles that differ only by a bracketed clause or a feat. credit
    // read as the same option.
    const key = answerKey(entry.title);
    if (keys.has(key)) continue;
    keys.add(key);
    distractors.push(entry);
  }
  const picked = shuffled([answer, ...distractors]);
  return picked.map(({ title, artist }) =>
    mode === "easy" ? { title, artist } : { title },
  );
}
