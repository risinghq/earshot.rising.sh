// A room's game as plain data. Each rule takes the stored room, who is
// present and the time, changes the room, and returns what the Durable Object
// must record or send. Nothing here touches storage, sockets, D1 or the clock.
import type { Choice, Mode, PoolEntry } from "../game/quiz";
import {
  matchTyped,
  poolOf,
  roundSeconds,
  roundsPerGame,
  sampleChoices,
  scoreFor,
  shuffled,
  upcomingTitles,
} from "../game/quiz";
import type {
  CategoryBoardEntry,
  PastRound,
  Reveal,
  RoomKind,
  RoomPreview,
  RoomState,
} from "./protocol";
import type { ResultRow } from "../game/results";
import type { Candidate } from "../catalog/sources";
import {
  type GameOrigin,
  type GameStart,
  type Outcome,
  playerKeyOf,
  trackKeyFor,
} from "../game/outcomes";

export const maxPlayers = 8;
export const nicknameMaxLength = 20;
// A signed-in seat keeps the GitHub login, which can run to 39 characters.
export const signInNameMaxLength = 39;

export const startLeadMs = 1500;
// Devices get this long to report the clip loaded; after it the round starts
// without the stragglers.
export const readyWaitMs = 4000;
export const revealMs = 6000;
export const quotaRetryMs = 2500;
export const idleMs = 3600_000;
// A match seat that never fills should not strand the player who did show
// up: the game starts with whoever connected after this wait.
export const matchWaitMs = 90_000;
// Up next holds one suggestion per player, so a full room fits.
const maxSuggestions = maxPlayers;

export interface Player {
  id: string;
  token: string;
  name: string;
  creator: boolean;
  userId: number | null;
  anon: string | null;
  score: number;
  streak: number;
  // Missing from a room stored before the count existed.
  correct?: number;
  // Right or wrong for each round of the current game, for the game bar.
  marks?: boolean[];
}

export interface SeatedPlayer {
  name: string;
  token: string;
  userId: number | null;
  anon?: string | null;
}

interface RoundAnswer {
  answer: string | null;
  correct: boolean;
  score: number;
  ms: number;
}

export interface Round {
  index: number;
  number: number;
  // When the clip was broadcast. startedAt is provisional at
  // servedAt + readyWaitMs + startLeadMs and moves earlier once every
  // connected player (and a watching screen) has reported the clip loaded.
  servedAt: number;
  startedAt: number;
  endsAt: number;
  loaded: string[];
  screenLoaded: boolean;
  choices: Choice[];
  link: string | null;
  cover: string | null;
  credit?: string;
  answers: Record<string, RoundAnswer>;
}

// A category someone wants next. Each player holds one vote; suggesting
// casts it.
interface Suggestion {
  id: string;
  slug: string;
  name: string;
  mode: Mode;
  by: string;
  voters: string[];
}

export interface Stored {
  code: string;
  kind: RoomKind;
  categorySlug: string;
  categoryName: string;
  mode: Mode;
  candidates: Candidate[];
  pool: PoolEntry[];
  creatorToken: string;
  players: Player[];
  gameId: string;
  seededAt: number;
  playedBy: number;
  next: number;
  served: number;
  phase: "lobby" | "loading" | "playing" | "reveal" | "done";
  round: Round | null;
  reveal: Reveal | null;
  // The current game's rounds, and every title it has shown as an answer
  // or an option. Missing from a room stored before they existed.
  history?: PastRound[];
  shown?: string[];
  // Up next, between games.
  suggestions?: Suggestion[];
  board: CategoryBoardEntry[];
  retryAt: number | null;
  lastActive: number;
}

export interface RoomTarget {
  categorySlug: string;
  categoryName: string;
  mode: Mode;
  candidates: Candidate[];
}

export interface RoomInit extends RoomTarget {
  code: string;
  kind: RoomKind;
  creatorToken: string;
  players: SeatedPlayer[];
}

// Who holds a live socket: the seats, and whether a screen watches. A screen
// holds no seat, so it never counts toward the seats, the answers awaited or
// the players a game starts with.
export interface Presence {
  connected: ReadonlySet<string>;
  screen: boolean;
}

export function seatedOk(players: SeatedPlayer[]) {
  const names = new Set<string>();
  for (const player of players) {
    const name = typeof player.name === "string" ? player.name.trim() : "";
    const max =
      player.userId === null ? nicknameMaxLength : signInNameMaxLength;
    if (
      name === "" ||
      [...name].length > max ||
      names.has(name.toLowerCase()) ||
      typeof player.token !== "string" ||
      (player.userId !== null && typeof player.userId !== "number")
    )
      return false;
    names.add(name.toLowerCase());
  }
  return true;
}

const freshPlayer = (
  id: string,
  seat: Omit<Player, "id" | "score" | "streak">,
): Player => ({ id, ...seat, score: 0, streak: 0 });

export function createRoom(
  init: RoomInit,
  now: number,
  newId: () => string,
): Stored {
  return {
    code: init.code,
    kind: init.kind,
    categorySlug: init.categorySlug,
    categoryName: init.categoryName,
    mode: init.mode,
    candidates: init.candidates,
    pool: poolOf(init.candidates),
    creatorToken: init.creatorToken,
    players: init.players.map((seated) =>
      freshPlayer(newId(), {
        token: seated.token,
        name: seated.name,
        creator: false,
        userId: seated.userId,
        anon: seated.anon ?? null,
      }),
    ),
    gameId: "",
    seededAt: now,
    playedBy: 0,
    next: 0,
    served: 0,
    phase: "lobby",
    round: null,
    reveal: null,
    board: [],
    retryAt: null,
    lastActive: now,
  };
}

// Fills fields a room stored by an older version lacks.
export function upgrade(s: Stored) {
  s.kind ??= "room";
  s.categorySlug ??= "";
  s.gameId ??= "";
  s.seededAt ??= s.lastActive;
  s.playedBy ??= 0;
  s.board ??= [];
  for (const player of s.players) {
    player.userId ??= null;
    player.streak ??= 0;
    player.anon ??= null;
  }
}

export interface SeatRequest {
  token: string | undefined;
  // The signed-in user on this socket, and their profile name.
  uid: number | null;
  signedName: string;
  typed: string;
  anon: string | null;
}

export type SeatResult =
  | { ok: true; player: Player; claimed: boolean }
  | { ok: false; code: "full" | "name" | "taken"; preview: boolean };

function nameTaken(s: Stored, name: string) {
  const key = name.toLowerCase();
  return s.players.some((p) => p.name.toLowerCase() === key);
}

function freeName(s: Stored, base: string) {
  if (!nameTaken(s, base)) return base;
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`;
    if (!nameTaken(s, name)) return name;
  }
}

// Finds or makes the seat a join asks for. `fresh` is the id and token a new
// seat takes; a request with its own token keeps it.
export function seat(
  s: Stored,
  request: SeatRequest,
  now: number,
  fresh: { id: string; token: string },
): SeatResult {
  const { token, uid } = request;
  let player =
    token === undefined ? undefined : s.players.find((p) => p.token === token);
  // A signed-in player keeps one seat across devices and cleared storage.
  if (player === undefined && uid !== null)
    player = s.players.find((p) => p.userId === uid);
  // A guest who signs in from this room comes back with the same seat
  // token: the seat moves into the account, and a finished game writes the
  // result it held back from the guest.
  const claimed =
    player !== undefined &&
    player.userId === null &&
    uid !== null &&
    !s.players.some((p) => p.userId === uid);
  if (claimed) player!.userId = uid;
  if (player === undefined) {
    // A match admits only the players the matchmaker seated.
    if (s.kind === "match") return { ok: false, code: "full", preview: true };
    const typed = request.typed.trim();
    const signedName = request.signedName.trim();
    const isCreator =
      s.creatorToken !== "" && token !== undefined && token === s.creatorToken;
    let nickname: string;
    if (typed === "" && uid !== null && signedName !== "") {
      // A signed-in player is seated under their profile name; a guest
      // who already took it pushes them to the next free variant.
      nickname = freeName(s, signedName);
    } else if (typed === "" && isCreator) {
      // The creator is seated on arrival; a guest creator with no saved
      // nickname plays as Host.
      nickname = freeName(s, "Host");
    } else {
      nickname = typed;
      if (nickname === "" || [...nickname].length > nicknameMaxLength)
        return { ok: false, code: "name", preview: true };
      if (nameTaken(s, nickname))
        return { ok: false, code: "taken", preview: false };
    }
    if (s.players.length >= maxPlayers)
      return { ok: false, code: "full", preview: true };
    player = freshPlayer(fresh.id, {
      token: token ?? fresh.token,
      name: nickname,
      creator: isCreator,
      userId: uid,
      anon: request.anon,
    });
    s.players.push(player);
  }
  s.lastActive = now;
  return { ok: true, player, claimed };
}

// A match has no creator to start it; it begins once every seat has a live
// socket.
export function matchFilled(s: Stored, presence: Presence) {
  return (
    s.kind === "match" &&
    s.phase === "lobby" &&
    s.players.length > 0 &&
    s.players.every((p) => presence.connected.has(p.id))
  );
}

// The creator points the room at another category or difficulty between
// games. Everyone stays seated and the room goes back to its lobby.
export function retarget(
  s: Stored,
  token: string,
  target: RoomTarget,
  now: number,
) {
  if (s.kind !== "room" || token === "" || token !== s.creatorToken) return 403;
  if (s.phase !== "lobby" && s.phase !== "done") return 409;
  s.categorySlug = target.categorySlug;
  s.categoryName = target.categoryName;
  s.mode = target.mode;
  s.candidates = target.candidates;
  s.pool = poolOf(target.candidates);
  s.phase = "lobby";
  s.reveal = null;
  s.round = null;
  s.board = [];
  s.suggestions = [];
  s.lastActive = now;
  return 204;
}

export const canSuggest = (s: Stored, pid: string) =>
  s.kind === "room" &&
  s.phase === "done" &&
  s.players.some((p) => p.id === pid);

export const suggestionFor = (s: Stored, slug: string, mode: Mode) =>
  s.suggestions?.find((x) => x.slug === slug && x.mode === mode);

// A player's new suggestion replaces their old one and casts their vote.
export function suggest(
  s: Stored,
  pid: string,
  category: { slug: string; name: string; mode: Mode },
  id: string,
  now: number,
) {
  if (!canSuggest(s, pid)) return false;
  const same = suggestionFor(s, category.slug, category.mode);
  if (same !== undefined) return vote(s, pid, same.id, now);
  const kept = (s.suggestions ?? []).filter((x) => x.by !== pid);
  if (kept.length >= maxSuggestions) return false;
  kept.push({ id, ...category, by: pid, voters: [] });
  s.suggestions = kept;
  return vote(s, pid, id, now);
}

export function vote(s: Stored, pid: string, id: string, now: number) {
  if (s.phase !== "done") return false;
  const list = s.suggestions ?? [];
  const target = list.find((x) => x.id === id);
  if (target === undefined || !s.players.some((p) => p.id === pid))
    return false;
  for (const x of list) x.voters = x.voters.filter((v) => v !== pid);
  target.voters.push(pid);
  s.lastActive = now;
  return true;
}

export const canStart = (s: Stored, pid: string) =>
  s.players.find((p) => p.id === pid)?.creator === true;

// Starts a fresh game in the room; a random id keeps its result rows
// distinct from any earlier game played under a reused code. Returns the
// start to record, or null when a game is already on.
export function begin(
  s: Stored,
  now: number,
  presence: Presence,
  gameId: string,
  picked?: "pick",
  shuffle: <T>(items: T[]) => T[] = shuffled,
): GameStart | null {
  if (s.phase !== "lobby" && s.phase !== "done") return null;
  const origin: GameOrigin =
    picked ??
    (s.kind === "match" ? "match" : s.phase === "done" ? "rematch" : "start");
  for (const p of s.players) {
    p.score = 0;
    p.streak = 0;
    p.correct = 0;
    p.marks = [];
  }
  s.history = [];
  s.shown = [];
  s.suggestions = [];
  s.candidates = shuffle(s.candidates);
  s.gameId = gameId;
  // A seat that never held a live socket did not play: the result rows
  // count who was there at the start, not who was invited.
  s.playedBy = s.players.filter((p) => presence.connected.has(p.id)).length;
  s.next = 0;
  s.served = 0;
  s.round = null;
  s.reveal = null;
  s.retryAt = null;
  s.phase = "loading";
  s.lastActive = now;
  return {
    id: s.gameId,
    kind: s.kind,
    room: s.code,
    category: s.categorySlug,
    mode: s.mode,
    origin,
    players: s.playedBy,
  };
}

// Takes the next candidate to resolve, or null when none is left.
export function takeCandidate(s: Stored) {
  s.retryAt = null;
  if (s.next >= s.candidates.length) return null;
  s.next += 1;
  return s.next - 1;
}

// A quota answer keeps the same candidate and retries after a short wait.
export function holdForQuota(s: Stored, index: number, now: number) {
  s.next = index;
  s.retryAt = now + quotaRetryMs;
}

// Opens the round on a resolved clip. The lead is measured from resolution,
// not from the request that started it: lookups and skipped candidates can
// take longer than the lead, and the clock must outlive the broadcast. The
// start is provisional: devices that report the clip loaded pull it earlier.
export function openRound(
  s: Stored,
  index: number,
  preview: { link?: string | null; cover?: string | null; credit?: string },
  now: number,
) {
  const candidate = s.candidates[index];
  const startedAt = now + readyWaitMs + startLeadMs;
  s.round = {
    index,
    number: s.served + 1,
    servedAt: now,
    startedAt,
    endsAt: startedAt + roundSeconds * 1000,
    loaded: [],
    screenLoaded: false,
    choices: sampleChoices(s.mode, s.pool, candidate, [
      ...(s.shown ?? []),
      ...upcomingTitles(s.candidates, index),
    ]),
    link: preview.link ?? candidate.link,
    cover: preview.cover ?? candidate.cover,
    credit: preview.credit,
    answers: {},
  };
  (s.shown ??= []).push(
    candidate.title,
    ...s.round.choices.map((choice) => choice.title),
  );
  s.served += 1;
  s.phase = "playing";
}

export function endGame(s: Stored) {
  s.phase = "done";
  s.round = null;
  s.reveal = null;
}

// The game ends after its rounds or when the candidates run out.
export const gameOver = (s: Stored) =>
  s.served >= roundsPerGame || s.next >= s.candidates.length;

// Scores an answer. Returns false when it does not count: no round, no
// seat, a second answer, or one sent before anyone could hear the clip.
export function answer(s: Stored, pid: string, value: string, now: number) {
  if (s.phase !== "playing" || s.round === null) return false;
  const player = s.players.find((p) => p.id === pid);
  if (player === undefined || s.round.answers[pid] !== undefined) return false;
  const candidate = s.candidates[s.round.index];
  if (now < s.round.startedAt) return false;
  const elapsed = now - s.round.startedAt;
  const timedOut = elapsed >= roundSeconds * 1000;
  let given: string | null;
  let correct: boolean;
  if (s.mode !== "hard") {
    given = value;
    correct = !timedOut && value === candidate.title;
  } else {
    given = value.trim();
    correct = !timedOut && given !== "" && matchTyped(given, candidate);
  }
  const score = correct ? scoreFor(elapsed) : 0;
  s.round.answers[pid] = { answer: given, correct, score, ms: elapsed };
  player.score += score;
  player.streak = correct ? player.streak + 1 : 0;
  if (correct) player.correct = (player.correct ?? 0) + 1;
  s.lastActive = now;
  return true;
}

// Everyone still connected has answered; a player who left no longer counts.
export const everyoneAnswered = (s: Stored, presence: Presence) =>
  s.round !== null &&
  [...presence.connected].every((pid) => s.round!.answers[pid] !== undefined);

// Closes the round into its reveal and returns one outcome row per player
// who answered. A room with no category writes none.
export function closeRound(s: Stored, now: number): Outcome[] {
  const round = s.round!;
  const candidate = s.candidates[round.index];
  const outcomes =
    s.categorySlug === ""
      ? []
      : s.players
          .filter((player) => round.answers[player.id] !== undefined)
          .map((player) => ({
            playerKey: playerKeyOf(player.userId, player.anon),
            userId: player.userId,
            track: candidate,
            category: s.categorySlug,
            mode: s.mode,
            kind: s.kind,
            correct: round.answers[player.id].correct,
            elapsedMs: round.answers[player.id].ms,
            gameId: s.gameId,
            round: round.number,
          }));
  for (const player of s.players) {
    // A player who joined mid-game has no marks for the rounds before.
    player.marks ??= [];
    while (player.marks.length < round.number - 1) player.marks.push(false);
    player.marks.push(round.answers[player.id]?.correct ?? false);
    // A round without an answer breaks the streak like a wrong one.
    if (round.answers[player.id] === undefined) player.streak = 0;
  }
  const reveal: Reveal = {
    number: round.number,
    track: trackKeyFor(candidate),
    title: candidate.title,
    original: candidate.original ?? null,
    ...(candidate.work ? { work: candidate.work } : {}),
    artist: round.credit ?? candidate.artist,
    cover: round.cover,
    link: round.link,
    until: now + revealMs,
    choices: round.choices,
    results: s.players.map((player) => {
      const given = round.answers[player.id];
      return {
        name: player.name,
        answer: given?.answer ?? null,
        correct: given?.correct ?? false,
        score: given?.score ?? 0,
        streak: player.streak,
      };
    }),
  };
  s.reveal = reveal;
  (s.history ??= []).push({
    number: reveal.number,
    title: reveal.title,
    original: reveal.original,
    ...(reveal.work ? { work: reveal.work } : {}),
    artist: reveal.artist,
    cover: reveal.cover,
    link: reveal.link,
    results: reveal.results,
  });
  s.round = null;
  s.phase = "reveal";
  return outcomes;
}

// A device reports its clip ready: a seat by id, or the screen.
export function markLoaded(s: Stored, who: string | "screen") {
  if (s.phase !== "playing" || s.round === null) return false;
  if (who === "screen") s.round.screenLoaded = true;
  else if (!s.round.loaded.includes(who)) s.round.loaded.push(who);
  return true;
}

// The round starts at the earliest of every connected player (and any
// screen) reporting the clip loaded, or the provisional deadline, plus the
// usual lead. Returns true when it moved the start. Safe on any change.
export function startEarly(s: Stored, now: number, presence: Presence) {
  const round = s.round;
  if (s.phase !== "playing" || round === null) return false;
  if (![...presence.connected].every((pid) => round.loaded.includes(pid)))
    return false;
  if (presence.screen && !round.screenLoaded) return false;
  const start = now + startLeadMs;
  if (start >= round.startedAt) return false;
  round.startedAt = start;
  round.endsAt = start + roundSeconds * 1000;
  return true;
}

// One row per signed-in player when the game finishes. Guests and games that
// never served a round write nothing; the row id makes a repeated finish a
// no-op.
export function resultRows(s: Stored, finishedAt: number): ResultRow[] {
  if (s.served === 0 || s.categorySlug === "" || s.gameId === "") return [];
  const ordered = [...s.players].sort((a, b) => b.score - a.score);
  return ordered
    .filter((player) => player.userId !== null)
    .map((player) => ({
      id: `r:${s.gameId}:${player.userId}`,
      userId: player.userId!,
      finishedAt,
      category: s.categorySlug,
      kind: s.kind,
      score: player.score,
      rank: 1 + ordered.filter((p) => p.score > player.score).length,
      players: s.playedBy === 0 ? s.players.length : s.playedBy,
      correct: player.correct ?? 0,
      rounds: s.served,
    }));
}

// When the alarm must next fire, or null. A deadline already past must not
// re-arm it: an alarm in the past fires at once and reschedules forever.
export function nextDue(s: Stored, now: number, presence: Presence) {
  const due = [s.lastActive + idleMs];
  if (s.kind === "match" && s.phase === "lobby" && presence.connected.size > 0)
    due.push(s.seededAt + matchWaitMs);
  if (s.phase === "playing" && s.round) due.push(s.round.endsAt);
  if (s.phase === "reveal" && s.reveal) due.push(s.reveal.until);
  if (s.phase === "loading" && s.retryAt !== null) due.push(s.retryAt);
  const future = due.filter((time) => time > now);
  return future.length > 0 ? Math.min(...future) : null;
}

export type Due = "expire" | "begin" | "close" | "advance" | "retry" | null;

// What a deadline that has passed asks for. An hour without client action
// ends the room whoever is connected.
export function dueAt(s: Stored, now: number, presence: Presence): Due {
  if (now - s.lastActive >= idleMs) return "expire";
  if (
    s.kind === "match" &&
    s.phase === "lobby" &&
    now >= s.seededAt + matchWaitMs &&
    presence.connected.size > 0
  )
    return "begin";
  if (s.phase === "playing" && s.round !== null && now >= s.round.endsAt)
    return "close";
  if (s.phase === "reveal" && s.reveal !== null && now >= s.reveal.until)
    return "advance";
  if (s.phase === "loading" && s.retryAt !== null && now >= s.retryAt)
    return "retry";
  return null;
}

// Most votes first; a tie keeps the order they were suggested in.
function upNext(s: Stored, pid: string | undefined) {
  return (s.suggestions ?? [])
    .map((x) => ({
      id: x.id,
      slug: x.slug,
      name: x.name,
      mode: x.mode,
      by: s.players.find((p) => p.id === x.by)?.name ?? "",
      votes: x.voters.length,
      voted: pid !== undefined && x.voters.includes(pid),
      mine: pid !== undefined && x.by === pid,
    }))
    .sort((a, b) => b.votes - a.votes);
}

// What one socket sees: a seat by id, or the screen when pid is undefined.
export function snapshot(
  s: Stored,
  pid: string | undefined,
  presence: Presence,
  clip: string | null,
  now: number,
): RoomState {
  const viewer = pid === undefined;
  const me = viewer ? undefined : s.players.find((player) => player.id === pid);
  const state: RoomState = {
    type: "state",
    code: s.code,
    kind: s.kind,
    category: s.categoryName,
    categorySlug: s.categorySlug,
    mode: s.mode,
    phase: s.phase,
    now,
    rounds: roundsPerGame,
    seats: maxPlayers,
    you: {
      name: me?.name ?? "",
      creator: me?.creator ?? false,
      user: me?.userId !== null && me?.userId !== undefined,
      marks: me?.marks ?? [],
      streak: me?.streak ?? 0,
      // This round's pick, so a reload keeps it locked in.
      answer: (me && s.round?.answers[me.id]?.answer) ?? null,
    },
    players: s.players.map((player) => ({
      name: player.name,
      creator: player.creator,
      user: player.userId !== null,
      score: player.score,
      connected: presence.connected.has(player.id),
      answered: s.round?.answers[player.id] !== undefined,
    })),
  };
  if (s.phase === "loading" && s.round === null) state.round = s.served + 1;
  if (s.round) {
    state.round = s.round.number;
    state.startedAt = s.round.startedAt;
    state.endsAt = s.round.endsAt;
    state.choices = s.round.choices;
    // While a screen watches, the clip plays there only: the players'
    // phones get no URL and cannot start a second, quieter playback.
    if (clip !== null && (viewer || !presence.screen)) state.clip = clip;
  }
  if (viewer) state.watch = true;
  else if (presence.screen) state.screen = true;
  if (s.phase === "reveal" && s.reveal) state.reveal = s.reveal;
  if (s.phase === "done") {
    state.standings = [...s.players]
      .sort((a, b) => b.score - a.score)
      .map((player) => ({
        name: player.name,
        score: player.score,
        correct: player.correct ?? 0,
      }));
    state.board = s.board;
    state.history = s.history ?? [];
    state.suggestions = upNext(s, pid);
  }
  return state;
}

// What a device that holds no seat may see: enough to show the room it is
// about to join, or the one it cannot join because it is full.
export const preview = (s: Stored): RoomPreview => ({
  type: "preview",
  code: s.code,
  category: s.categoryName,
  categorySlug: s.categorySlug,
  mode: s.mode,
  rounds: roundsPerGame,
  seats: maxPlayers,
  players: s.players.map((player) => player.name),
});
