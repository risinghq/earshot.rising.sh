import { normalizeText } from "../normalize";
import {
  deezerIsrcPreview,
  deezerPreview,
  deezerSearchPreview,
  QuotaError,
  type Candidate,
} from "./sources";

export const roundSeconds = 15;
export const roundsPerGame = 10;
export const maxChoices = 4;

export type Mode = "choices" | "typed";

export function shuffled<T>(items: T[]): T[] {
  const order = crypto.getRandomValues(new Uint32Array(items.length));
  return items
    .map((item, i) => ({ item, sort: order[i] }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ item }) => item);
}

// Resolves the clip for one candidate: Deezer id first, then the ISRC
// lookup, then an artist-checked search. QuotaError propagates so the
// caller can hold the round instead of skipping the track.
export async function candidatePreview(candidate: Candidate) {
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

export function scoreFor(elapsedMs: number) {
  if (elapsedMs >= roundSeconds * 1000) return 0;
  return Math.round(1000 - (900 * elapsedMs) / (roundSeconds * 1000));
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

// Bracketed clauses and a feat. credit are part of a title on a service but
// not of the name a player remembers.
export function answerKey(text: string) {
  const stripped = text
    .replace(/[[(][^\])]*[\])]/g, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, "");
  return normalizeText(stripped);
}

export function matchTyped(input: string, title: string) {
  const given = answerKey(input);
  const wanted = answerKey(title);
  if (given === "" || wanted === "") return false;
  if (given === wanted) return true;
  const limit = wanted.length >= 10 ? 2 : 1;
  return levenshtein(given, wanted) <= limit;
}

// The distractor set is sampled once per round: re-sampling would let a
// reload narrow the answer to the title present in both lists.
export function sampleChoices(pool: string[], answer: string) {
  const answerNorm = answerKey(answer);
  const others = pool.filter(
    (title) => title !== answer && answerKey(title) !== answerNorm,
  );
  return shuffled([answer, ...shuffled(others).slice(0, maxChoices - 1)]);
}
