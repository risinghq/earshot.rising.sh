import { base64url } from "../auth";
import type { Env } from "../types";
import type { Category } from "./catalog";
import { playerKeyOf, recordOutcomes, trackKeyFor } from "./outcomes";
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
// The longest a served round may wait for the client's "clip is playing"
// report before the clock starts anyway.
export const startCapMs = 5000;
export type Phase = "question" | "reveal" | "done";

export interface RoundResult {
  trackKey: string;
  title: string;
  artist: string;
  cover: string | null;
  link: string | null;
  answer: string | null;
  correct: boolean;
  timedOut: boolean;
  score: number;
  elapsedMs: number;
  choices: string[];
}

export interface Game {
  id: string;
  userId: number | null;
  playerKey: string;
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
    // When the round was handed to a page. The clock does not run from here:
    // it runs from startedAt once the client reports the clip playing, and a
    // report arriving later than startCapMs counts as servedAt + startCapMs.
    // A report that never arrives leaves startedAt null and scoring falls
    // back to servedAt, as a no-JS round always did.
    servedAt: number;
    startedAt: number | null;
    reveal: { link: string | null; cover: string | null };
    choices: string[];
  } | null;
  // The next round's clip, resolved while the reveal is shown, so Next does
  // not wait on a lookup. The URL is held only until the round is served.
  pending?: {
    index: number;
    url: string;
    link: string | null;
    cover: string | null;
    choices: string[];
  } | null;
  results: RoundResult[];
  total: number;
  resultWritten?: boolean;
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
  userId: number | null = null,
  playerKey = playerKeyOf(userId, null),
): Promise<Game> {
  const game: Game = {
    id: base64url(crypto.getRandomValues(new Uint8Array(16))),
    userId,
    playerKey,
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
  // A round prepared during the reveal is consumed as-is: its clip was
  // already resolved and preloaded, so only the serve stamp is new.
  if (game.pending !== undefined && game.pending !== null) {
    const pending = game.pending;
    game.pending = null;
    game.current = {
      index: pending.index,
      servedAt: now,
      startedAt: null,
      reveal: { link: pending.link, cover: pending.cover },
      choices: pending.choices,
    };
    game.served += 1;
    await putGame(env, game);
    return {
      game,
      preview: {
        url: pending.url,
        link: pending.link,
        cover: pending.cover,
      },
      quota: false,
    };
  }
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
      startedAt: null,
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

// The client reports the clip actually playing; that moment starts the
// round's clock, capped at startCapMs after the round was served so a late
// report cannot buy time. Repeat reports keep the first start, so a reload
// cannot move the clock either.
export async function reportPlaying(
  env: Env,
  game: Game,
  now: number,
): Promise<number | null> {
  if (game.phase !== "question" || game.current === null) return null;
  if (game.current.startedAt === null) {
    game.current.startedAt = Math.min(now, game.current.servedAt + startCapMs);
    await putGame(env, game);
  }
  return Math.max(0, roundSeconds * 1000 - (now - game.current.startedAt));
}

// Resolves the clip for the round after the reveal so the client's preload
// and the next serve need no new lookup. Pending data is consumed by
// serveRound; a quota answer holds the candidates where they are.
export async function prepareNext(
  env: Env,
  game: Game,
): Promise<string | null> {
  if (game.phase !== "reveal") return null;
  if (game.pending !== undefined && game.pending !== null)
    return game.pending.url;
  if (game.results.length >= roundsPerGame) return null;
  // Resolve on local counters: the awaited lookups may race a /next that
  // serves the round, and saving this snapshot would erase it. State moves
  // only after a fresh re-read below.
  const held = game.next;
  let nextIndex = held;
  let pending: NonNullable<Game["pending"]> | null = null;
  while (nextIndex < game.candidates.length) {
    const index = nextIndex;
    nextIndex += 1;
    const candidate = game.candidates[index];
    let preview: Preview | null;
    try {
      preview = await candidatePreview(candidate);
    } catch (error) {
      if (error instanceof QuotaError) return null;
      continue;
    }
    if (preview === null) continue;
    pending = {
      index,
      url: preview.url,
      link: preview.link ?? candidate.link,
      cover: preview.cover ?? candidate.cover,
      choices:
        game.mode === "choices"
          ? sampleChoices(game.pool, candidate.title)
          : [],
    };
    break;
  }
  if (pending === null) return null;
  const fresh = await getGame(env, game.id);
  if (
    fresh === null ||
    fresh.phase !== "reveal" ||
    fresh.next !== held ||
    fresh.results.length !== game.results.length
  )
    return null;
  fresh.next = nextIndex;
  fresh.pending = pending;
  await putGame(env, fresh);
  return pending.url;
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
  const elapsed = now - (game.current.startedAt ?? game.current.servedAt);
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
    trackKey: trackKeyFor(candidate),
    title: candidate.title,
    artist: candidate.artist,
    cover: game.current.reveal.cover,
    link: game.current.reveal.link,
    answer: given,
    correct,
    timedOut,
    score,
    elapsedMs: elapsed,
    choices: game.current.choices,
  };
  game.results.push(result);
  game.total += score;
  game.current = null;
  game.phase = "reveal";
  await putGame(env, game);
  await recordOutcomes(env, [
    {
      playerKey: game.playerKey,
      userId: game.userId,
      track: candidate,
      category: candidate.category ?? game.categorySlug,
      mode: game.mode,
      kind: "solo",
      correct,
      elapsedMs: elapsed,
    },
  ]).catch((error) => console.error("solo outcome write failed", error));
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
