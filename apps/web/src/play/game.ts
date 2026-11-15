import { base64url } from "../auth";
import type { Env } from "../types";
import type { Category } from "./catalog";
import {
  candidatePreview,
  roundSeconds,
  roundsPerGame,
  sampleChoices,
  scoreFor,
  shuffled,
  matchTyped,
} from "./quiz";
import type { Mode } from "./quiz";
import { QuotaError, type Candidate, type Preview } from "./sources";

export { matchTyped, roundSeconds, roundsPerGame, scoreFor } from "./quiz";
export type { Mode } from "./quiz";

const gameTtlSeconds = 3600;
export type Phase = "question" | "reveal" | "done";

export interface RoundResult {
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  answer: string | null;
  correct: boolean;
  timedOut: boolean;
  score: number;
}

export interface Game {
  id: string;
  mode: Mode;
  categorySlug: string;
  categoryName: string;
  candidates: Candidate[];
  pool: string[];
  next: number;
  served: number;
  phase: Phase;
  current: {
    index: number;
    servedAt: number;
    reveal: { link: string | null; cover: string | null };
    choices: string[];
  } | null;
  results: RoundResult[];
  total: number;
}

const gameKey = (id: string) => `play:game:${id}`;

export async function getGame(env: Env, id: string) {
  return (
    (await env.CACHE?.get<Game>(gameKey(id), "json").catch(() => null)) ?? null
  );
}

export async function putGame(env: Env, game: Game) {
  await env.CACHE?.put(gameKey(game.id), JSON.stringify(game), {
    expirationTtl: gameTtlSeconds,
  });
}

export async function buildGame(
  env: Env,
  category: Category,
  mode: Mode,
  candidates: Candidate[],
): Promise<Game> {
  const game: Game = {
    id: base64url(crypto.getRandomValues(new Uint8Array(16))),
    mode,
    categorySlug: category.slug,
    categoryName: category.name,
    candidates: shuffled(candidates),
    pool: [...new Set(candidates.map((track) => track.title))],
    next: 0,
    served: 0,
    phase: "question",
    current: null,
    results: [],
    total: 0,
  };
  await putGame(env, game);
  return game;
}

export interface Served {
  game: Game;
  preview: Preview | null;
  // A Deezer quota answer holds the round: nothing was written to KV, so a
  // later request tries the same candidate again.
  quota: boolean;
}

// Skips candidates with no resolvable preview; the round is served only once
// a preview URL exists, so the timer never runs against a dead clip.
export async function serveRound(
  env: Env,
  game: Game,
  now: number,
): Promise<Served> {
  if (game.current !== null) {
    // A refresh re-resolves the preview; the round's clock keeps its first
    // servedAt, so a reload cannot buy time.
    try {
      const preview = await candidatePreview(
        game.candidates[game.current.index],
      );
      return { game, preview, quota: false };
    } catch (error) {
      return {
        game,
        preview: null,
        quota: error instanceof QuotaError,
      };
    }
  }
  const held = game.next;
  while (game.next < game.candidates.length) {
    const index = game.next;
    game.next += 1;
    const candidate = game.candidates[index];
    let preview: Preview | null;
    try {
      preview = await candidatePreview(candidate);
    } catch (error) {
      if (error instanceof QuotaError) {
        game.next = held;
        return { game, preview: null, quota: true };
      }
      continue;
    }
    if (preview === null) continue;
    // The signed preview URL goes only to the page it was resolved for; the
    // stored round keeps the reveal data, never the URL itself.
    game.current = {
      index,
      servedAt: now,
      reveal: {
        link: preview.link ?? candidate.link,
        cover: preview.cover ?? candidate.cover,
      },
      choices:
        game.mode === "choices"
          ? sampleChoices(game.pool, candidate.title)
          : [],
    };
    game.served += 1;
    await putGame(env, game);
    return { game, preview, quota: false };
  }
  game.phase = "done";
  await putGame(env, game);
  return { game, preview: null, quota: false };
}

export interface Answered {
  game: Game;
  result: RoundResult;
}

export async function answerRound(
  env: Env,
  game: Game,
  answer: { choice?: string; typed?: string },
  now: number,
): Promise<Answered | null> {
  if (game.phase !== "question" || game.current === null) return null;
  const candidate = game.candidates[game.current.index];
  const elapsed = now - game.current.servedAt;
  const timedOut = elapsed >= roundSeconds * 1000;
  let given: string | null;
  let correct: boolean;
  if (game.mode === "choices") {
    given = answer.choice ?? null;
    correct = !timedOut && given === candidate.title;
  } else {
    given = answer.typed?.trim() ? answer.typed!.trim() : null;
    correct = !timedOut && given !== null && matchTyped(given, candidate.title);
  }
  const score = correct ? scoreFor(elapsed) : 0;
  const result: RoundResult = {
    title: candidate.title,
    artist: candidate.artist,
    cover: game.current.reveal.cover,
    link: game.current.reveal.link,
    answer: given,
    correct,
    timedOut,
    score,
  };
  game.results.push(result);
  game.total += score;
  game.current = null;
  game.phase = "reveal";
  await putGame(env, game);
  return { game, result };
}

// The game ends when the round count is reached or the candidates ran out;
// both can only be decided after a reveal is acknowledged.
export function advance(game: Game) {
  if (game.phase !== "reveal") return false;
  game.phase =
    game.served >= roundsPerGame || game.next >= game.candidates.length
      ? "done"
      : "question";
  return true;
}
