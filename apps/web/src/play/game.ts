import { base64url } from "../auth";
import type { Env } from "../types";
import type { Category } from "./catalog";
import { playerKeyOf, recordOutcomes, trackKeyFor } from "./outcomes";
import {
  candidatePreview,
  roundSeconds,
  roundsPerGame,
  poolOf,
  sampleChoices,
  scoreFor,
  shuffled,
  matchTyped,
  upcomingTitles,
} from "./quiz";
import type { Choice, Mode, PoolEntry } from "./quiz";
import { QuotaError, type Candidate, type Preview } from "./sources";

export { matchTyped, roundSeconds, roundsPerGame, scoreFor } from "./quiz";
export type { Mode } from "./quiz";

// The longest a served round may wait for the client's "clip is playing"
// report before the clock starts anyway.
export const startCapMs = 5000;
export type Phase = "question" | "reveal" | "done";

export interface RoundResult {
  trackKey: string;
  title: string;
  original?: string;
  artist: string;
  cover: string | null;
  link: string | null;
  answer: string | null;
  correct: boolean;
  timedOut: boolean;
  score: number;
  elapsedMs: number;
  choices: Choice[];
}

export interface Game {
  id: string;
  userId: number | null;
  playerKey: string;
  mode: Mode;
  categorySlug: string;
  categoryName: string;
  candidates: Candidate[];
  pool: PoolEntry[];
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
    reveal: { link: string | null; cover: string | null; credit?: string };
    choices: Choice[];
  } | null;
  // The next round's clip, resolved while the reveal is shown, so Next does
  // not wait on a lookup. The URL is held only until the round is served.
  pending?: {
    index: number;
    url: string;
    link: string | null;
    cover: string | null;
    credit?: string;
    choices: Choice[];
  } | null;
  results: RoundResult[];
  total: number;
  resultWritten?: boolean;
}

const soloGame = (env: Env, id: string) =>
  env.SOLO.get(env.SOLO.idFromName(id));

// Game ids are 16 random bytes in base64url; anything else is not a game, and
// is refused before it can name a Durable Object.
const gameIdPattern = /^[A-Za-z0-9_-]{22}$/;

export async function getGame(env: Env, id: string): Promise<Game | null> {
  if (!gameIdPattern.test(id)) return null;
  return soloGame(env, id).read();
}

export async function putGame(env: Env, game: Game) {
  await soloGame(env, game.id).write(game);
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
    pool: poolOf(candidates),
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

// Every title this game has put on screen, as an answer or as an option, and
// the answers still to come after candidate `index`.
function avoidTitles(game: Game, index: number) {
  return [
    ...game.results.flatMap((result) => [
      result.title,
      ...result.choices.map((choice) => choice.title),
    ]),
    ...upcomingTitles(game.candidates, index),
  ];
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
      reveal: {
        link: pending.link,
        cover: pending.cover,
        credit: pending.credit,
      },
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
        credit: preview.credit,
      },
      choices: sampleChoices(
        game.mode,
        game.pool,
        candidate,
        avoidTitles(game, index),
      ),
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
      credit: preview.credit,
      choices: sampleChoices(
        game.mode,
        game.pool,
        candidate,
        avoidTitles(game, index),
      ),
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

// The prepared round as its question page would show it, without serving it:
// nothing is stored and no clock is stamped. The client renders this from
// memory on Continue, and the /next that follows serves the same round.
export function previewNext(
  game: Game,
  now: number,
): { game: Game; preview: Preview } | null {
  const pending = game.pending;
  if (game.phase !== "reveal" || pending === undefined || pending === null)
    return null;
  return {
    game: {
      ...game,
      phase: "question",
      served: game.served + 1,
      pending: null,
      current: {
        index: pending.index,
        servedAt: now,
        startedAt: null,
        reveal: {
          link: pending.link,
          cover: pending.cover,
          credit: pending.credit,
        },
        choices: pending.choices,
      },
    },
    preview: { url: pending.url, link: pending.link, cover: pending.cover },
  };
}

export interface Answered {
  game: Game;
  result: RoundResult;
  outcome: Promise<unknown>;
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
  if (game.mode !== "hard") {
    given = answer.choice ?? null;
    correct = !timedOut && given === candidate.title;
  } else {
    given = answer.typed?.trim() ? answer.typed!.trim() : null;
    correct = !timedOut && given !== null && matchTyped(given, candidate);
  }
  const score = correct ? scoreFor(elapsed) : 0;
  const result: RoundResult = {
    trackKey: trackKeyFor(candidate),
    title: candidate.title,
    ...(candidate.original ? { original: candidate.original } : {}),
    artist: game.current.reveal.credit ?? candidate.artist,
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
  // The verdict does not wait on the D1 write: the caller decides whether to
  // await it or hand it to waitUntil.
  const outcome = recordOutcomes(env, [
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
  return { game, result, outcome };
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
