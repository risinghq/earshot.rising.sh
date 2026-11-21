import { DurableObject } from "cloudflare:workers";
import { base64url } from "../auth";
import type { Env } from "../types";
import type { Choice, Mode, PoolEntry } from "./quiz";
import {
  candidatePreview,
  matchTyped,
  parseMode,
  poolOf,
  roundSeconds,
  roundsPerGame,
  sampleChoices,
  scoreFor,
  upcomingTitles,
  shuffled,
} from "./quiz";
import {
  readCategoryBoard,
  recordResults,
  type CategoryBoardEntry,
  type ResultRow,
} from "./results";
import { QuotaError, type Candidate } from "./sources";
import {
  type GameOrigin,
  playerKeyOf,
  recordGameStart,
  recordOutcomes,
  trackKeyFor,
} from "./outcomes";
import { getCategory } from "./catalog";

export const maxPlayers = 8;
export const nicknameMaxLength = 20;
// A signed-in seat keeps the GitHub login, which can run to 39 characters.
export const signInNameMaxLength = 39;
export const roomCodeLength = 6;
// No 0/O, 1/I/L, so the code reads unambiguously out loud.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const startLeadMs = 1500;
// Devices get this long to report the clip loaded; after it the round starts
// without the stragglers.
const readyWaitMs = 4000;
const revealMs = 6000;
const quotaRetryMs = 2500;
const idleMs = 3600_000;
// A match seat that never fills should not strand the player who did show
// up: the game starts with whoever connected after this wait.
export const matchWaitMs = 90_000;
// Up next holds one suggestion per player, so a full room fits.
const maxSuggestions = maxPlayers;

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(roomCodeLength));
  return [...bytes]
    .map((byte) => codeAlphabet[byte % codeAlphabet.length])
    .join("");
}

export function isRoomCode(value: string) {
  return (
    value.length === roomCodeLength &&
    [...value].every((char) => codeAlphabet.includes(char))
  );
}

export function newRoomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

interface Player {
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

export type RoomKind = "room" | "match";

interface SeatedPlayer {
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

interface Round {
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

interface Reveal {
  number: number;
  track: string;
  title: string;
  original: string | null;
  artist: string;
  cover: string | null;
  link: string | null;
  until: number;
  choices: Choice[];
  results: {
    name: string;
    answer: string | null;
    correct: boolean;
    score: number;
    streak: number;
  }[];
}

// A finished round as the final card lists it.
type PastRound = Omit<Reveal, "until" | "track" | "choices">;

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

interface Stored {
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

interface SocketInfo {
  pid?: string;
  uid?: number;
  // The signed-in user's name, which seats them without a nickname.
  name?: string;
  anon?: string;
  watch?: boolean;
}

export interface RoomTarget {
  categorySlug: string;
  categoryName: string;
  mode: Mode;
  candidates: Candidate[];
}

const storageKey = "room";

function seatedOk(players: SeatedPlayer[]) {
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

export class Room extends DurableObject<Env> {
  private s?: Stored;
  // The signed preview URL lives in memory only; it is never written to
  // storage. An evicted object re-resolves it for players who reconnect.
  private clip: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = await ctx.storage.get<Stored>(storageKey);
      if (this.s !== undefined) {
        this.s.kind ??= "room";
        this.s.categorySlug ??= "";
        this.s.gameId ??= "";
        this.s.seededAt ??= this.s.lastActive;
        this.s.playedBy ??= 0;
        this.s.board ??= [];
        for (const player of this.s.players) {
          player.userId ??= null;
          player.streak ??= 0;
          player.anon ??= null;
        }
        if ((await ctx.storage.getAlarm()) === null) await this.schedule();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") {
      if (this.s !== undefined)
        return Response.json({ error: "room already exists" }, { status: 409 });
      const body = (await request.json()) as {
        code?: string;
        kind?: RoomKind;
        categorySlug?: string;
        categoryName?: string;
        mode?: Mode;
        candidates?: Candidate[];
        creatorToken?: string;
        players?: SeatedPlayer[];
      };
      const mode = parseMode(body.mode);
      if (
        typeof body.code !== "string" ||
        (body.kind !== undefined &&
          body.kind !== "room" &&
          body.kind !== "match") ||
        typeof body.categorySlug !== "string" ||
        typeof body.categoryName !== "string" ||
        mode === null ||
        !Array.isArray(body.candidates) ||
        typeof body.creatorToken !== "string" ||
        (body.players !== undefined && !seatedOk(body.players))
      )
        return Response.json({ error: "bad init" }, { status: 400 });
      const now = Date.now();
      this.s = {
        code: body.code,
        kind: body.kind ?? "room",
        categorySlug: body.categorySlug,
        categoryName: body.categoryName,
        mode,
        candidates: body.candidates,
        pool: poolOf(body.candidates),
        creatorToken: body.creatorToken,
        players: (body.players ?? []).map((seated) => ({
          id: base64url(crypto.getRandomValues(new Uint8Array(8))),
          token: seated.token,
          name: seated.name,
          creator: false,
          userId: seated.userId,
          anon: seated.anon ?? null,
          score: 0,
          streak: 0,
        })),
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
      await this.save();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/exists")
      return new Response(null, { status: this.s === undefined ? 404 : 200 });
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // The Worker read the session and put the user id in the URL; the
      // client cannot reach this handler except through that route.
      const uid = Number(url.searchParams.get("u"));
      const signedIn = Number.isInteger(uid) && uid > 0;
      pair[1].serializeAttachment({
        uid: signedIn ? uid : undefined,
        name: signedIn ? (url.searchParams.get("n") ?? undefined) : undefined,
        anon: url.searchParams.get("a") ?? undefined,
      } satisfies SocketInfo);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method === "POST" && url.pathname === "/retarget") {
      const body = (await request.json()) as Partial<RoomTarget> & {
        token?: string;
        start?: boolean;
      };
      const mode = parseMode(body.mode);
      if (
        typeof body.categorySlug !== "string" ||
        typeof body.categoryName !== "string" ||
        mode === null ||
        !Array.isArray(body.candidates)
      )
        return Response.json({ error: "bad target" }, { status: 400 });
      const status = await this.retarget(body.token ?? "", {
        categorySlug: body.categorySlug,
        categoryName: body.categoryName,
        mode,
        candidates: body.candidates,
      });
      // Picked from Up next, the game starts at once: everyone is seated
      // and their sound already works.
      if (status === 204 && body.start === true)
        await this.begin(Date.now(), "pick");
      return new Response(null, { status });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let message: {
      type?: string;
      name?: unknown;
      token?: unknown;
      answer?: unknown;
      category?: unknown;
      mode?: unknown;
      id?: unknown;
    };
    try {
      message = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      return;
    }
    const pid = this.pidOf(ws);
    if (message.type === "watch") {
      await this.watch(ws);
    } else if (message.type === "join") {
      await this.join(
        ws,
        typeof message.name === "string" ? message.name : undefined,
        typeof message.token === "string" ? message.token : undefined,
        Date.now(),
      );
    } else if (message.type === "start" && pid !== undefined) {
      await this.start(pid, Date.now());
    } else if (message.type === "loaded") {
      await this.markLoaded(ws, Date.now());
    } else if (
      message.type === "answer" &&
      pid !== undefined &&
      typeof message.answer === "string"
    ) {
      await this.answer(pid, message.answer.slice(0, 200), Date.now());
    } else if (
      message.type === "suggest" &&
      pid !== undefined &&
      typeof message.category === "string"
    ) {
      await this.suggest(pid, message.category.slice(0, 80), message.mode);
    } else if (
      message.type === "vote" &&
      pid !== undefined &&
      typeof message.id === "string"
    ) {
      await this.vote(pid, message.id);
    }
  }

  async webSocketClose() {
    const now = Date.now();
    // The departed player no longer counts toward the round; if they were
    // the last one unanswered, close it early like an answer would. Their
    // missing "loaded" report stops counting the same way.
    if (
      this.s?.phase === "playing" &&
      this.s.round !== null &&
      this.everyoneAnswered()
    ) {
      await this.closeRound(now);
      await this.save();
    } else if (this.maybeStartEarly(now)) {
      await this.save();
    }
    this.broadcast();
  }

  webSocketError() {
    this.broadcast();
  }

  private infoOf(ws: WebSocket): SocketInfo {
    return (ws.deserializeAttachment() as SocketInfo | null) ?? {};
  }

  private pidOf(ws: WebSocket) {
    return this.infoOf(ws).pid;
  }

  private uidOf(ws: WebSocket) {
    return (ws.deserializeAttachment() as SocketInfo | null)?.uid ?? null;
  }

  private anonOf(ws: WebSocket) {
    return (ws.deserializeAttachment() as SocketInfo | null)?.anon ?? null;
  }

  private socketsOf(pid: string) {
    return this.ctx.getWebSockets().filter((ws) => this.pidOf(ws) === pid);
  }

  private connectedPids() {
    return new Set(
      this.ctx
        .getWebSockets()
        .map((ws) => this.pidOf(ws))
        .filter((pid): pid is string => pid !== undefined),
    );
  }

  private send(ws: WebSocket, value: unknown) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      // A dying socket is dropped by the close handler.
    }
  }

  private watching(ws: WebSocket) {
    return (ws.deserializeAttachment() as SocketInfo | null)?.watch === true;
  }

  private hasScreen() {
    return this.ctx.getWebSockets().some((ws) => this.watching(ws));
  }

  private broadcast() {
    if (this.s === undefined) return;
    for (const ws of this.ctx.getWebSockets()) {
      if (this.watching(ws)) {
        this.send(ws, this.snapshot(undefined));
      } else {
        const pid = this.pidOf(ws);
        if (pid !== undefined) this.send(ws, this.snapshot(pid));
      }
    }
  }

  private snapshot(pid: string | undefined) {
    const s = this.s!;
    const viewer = pid === undefined;
    const me = viewer
      ? undefined
      : s.players.find((player) => player.id === pid);
    const connected = this.connectedPids();
    const screened = this.hasScreen();
    const snapshot: Record<string, unknown> = {
      type: "state",
      code: s.code,
      kind: s.kind,
      category: s.categoryName,
      categorySlug: s.categorySlug,
      mode: s.mode,
      phase: s.phase,
      now: Date.now(),
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
        connected: connected.has(player.id),
        answered: s.round?.answers[player.id] !== undefined,
      })),
    };
    if (s.phase === "loading" && s.round === null)
      snapshot.round = s.served + 1;
    if (s.round) {
      snapshot.round = s.round.number;
      snapshot.startedAt = s.round.startedAt;
      snapshot.endsAt = s.round.endsAt;
      snapshot.choices = s.round.choices;
      // While a screen watches, the clip plays there only: the players'
      // phones get no URL and cannot start a second, quieter playback.
      if (this.clip !== null && (viewer || !screened))
        snapshot.clip = this.clip;
    }
    if (viewer) snapshot.watch = true;
    else if (screened) snapshot.screen = true;
    if (s.phase === "reveal" && s.reveal) snapshot.reveal = s.reveal;
    if (s.phase === "done") {
      snapshot.standings = [...s.players]
        .sort((a, b) => b.score - a.score)
        .map((player) => ({
          name: player.name,
          score: player.score,
          correct: player.correct ?? 0,
        }));
      snapshot.board = s.board;
      snapshot.history = s.history ?? [];
      snapshot.suggestions = this.upNext(pid);
    }
    return snapshot;
  }

  // Most votes first; a tie keeps the order they were suggested in.
  private upNext(pid: string | undefined) {
    const s = this.s!;
    return (s.suggestions ?? [])
      .map((x) => ({
        id: x.id,
        slug: x.slug,
        name: x.name,
        mode: x.mode,
        by: s.players.find((p) => p.id === x.by)?.name ?? "",
        votes: x.voters.length,
        voted: pid !== undefined && x.voters.includes(pid),
      }))
      .sort((a, b) => b.votes - a.votes);
  }

  // What a device that holds no seat may see: enough to show the room it is
  // about to join, or the one it cannot join because it is full.
  private preview() {
    const s = this.s!;
    return {
      type: "preview",
      code: s.code,
      category: s.categoryName,
      categorySlug: s.categorySlug,
      mode: s.mode,
      rounds: roundsPerGame,
      seats: maxPlayers,
      players: s.players.map((player) => player.name),
    };
  }

  private async save() {
    if (this.s === undefined) return;
    await this.ctx.storage.put(storageKey, this.s);
    await this.schedule();
  }

  private async schedule() {
    const s = this.s;
    if (s === undefined) return;
    const now = Date.now();
    const due = [s.lastActive + idleMs];
    if (
      s.kind === "match" &&
      s.phase === "lobby" &&
      s.players.some((p) => this.socketsOf(p.id).length > 0)
    )
      due.push(s.seededAt + matchWaitMs);
    if (s.phase === "playing" && s.round) due.push(s.round.endsAt);
    if (s.phase === "reveal" && s.reveal) due.push(s.reveal.until);
    if (s.phase === "loading" && s.retryAt !== null) due.push(s.retryAt);
    // A deadline already past must not re-arm the alarm: an alarm in the
    // past fires at once and reschedules itself forever.
    const future = due.filter((time) => time > now);
    if (future.length > 0) await this.ctx.storage.setAlarm(Math.min(...future));
  }

  // A screen opens as a viewer: it holds no seat, scores nothing, and its
  // socket never counts as a connected player — not for maxPlayers, not for
  // the seats a match waits for, and not for the no-one-here guard that
  // stops a match room from starting alone.
  async watch(ws: WebSocket) {
    const s = this.s;
    if (s === undefined) {
      this.send(ws, { type: "error", code: "gone" });
      ws.close(1000, "room closed");
      return;
    }
    ws.serializeAttachment({
      ...this.infoOf(ws),
      watch: true,
    } satisfies SocketInfo);
    this.send(ws, this.snapshot(undefined));
    // The players' snapshots change too: from now on the clip is the
    // screen's, so their next state carries no URL.
    this.broadcast();
    if (this.clip === null) this.ensureClip();
  }

  async join(
    ws: WebSocket,
    name: string | undefined,
    token: string | undefined,
    now: number,
  ) {
    const s = this.s;
    if (s === undefined) {
      this.send(ws, { type: "error", code: "gone" });
      ws.close(1000, "room closed");
      return;
    }
    const uid = this.uidOf(ws);
    let player =
      token === undefined
        ? undefined
        : s.players.find((p) => p.token === token);
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
    if (claimed) {
      player!.userId = uid;
      if (s.phase === "done") {
        await this.recordResults();
        s.board =
          s.categorySlug === ""
            ? []
            : await readCategoryBoard(this.env, s.categorySlug).catch(
                () => s.board,
              );
      }
    }
    if (player === undefined) {
      // A match admits only the players the matchmaker seated.
      if (s.kind === "match") {
        this.send(ws, this.preview());
        this.send(ws, { type: "error", code: "full" });
        return;
      }
      const typed = name?.trim() ?? "";
      const signedName = this.infoOf(ws).name?.trim() ?? "";
      const isCreator =
        s.creatorToken !== "" &&
        token !== undefined &&
        token === s.creatorToken;
      let nickname: string;
      if (typed === "" && uid !== null && signedName !== "") {
        // A signed-in player is seated under their profile name; a guest
        // who already took it pushes them to the next free variant.
        nickname = this.freeName(signedName);
      } else if (typed === "" && isCreator) {
        // The creator is seated on arrival; a guest creator with no saved
        // nickname plays as Host.
        nickname = this.freeName("Host");
      } else {
        nickname = typed;
        if (nickname === "" || [...nickname].length > nicknameMaxLength) {
          this.send(ws, this.preview());
          this.send(ws, { type: "error", code: "name" });
          return;
        }
        if (this.nameTaken(nickname)) {
          this.send(ws, { type: "error", code: "taken" });
          return;
        }
      }
      if (s.players.length >= maxPlayers) {
        this.send(ws, this.preview());
        this.send(ws, { type: "error", code: "full" });
        return;
      }
      player = {
        id: base64url(crypto.getRandomValues(new Uint8Array(8))),
        token: token ?? newRoomSecret(),
        name: nickname,
        creator: isCreator,
        userId: uid,
        anon: this.anonOf(ws),
        score: 0,
        streak: 0,
      };
      s.players.push(player);
    }
    ws.serializeAttachment({
      ...this.infoOf(ws),
      pid: player.id,
    } satisfies SocketInfo);
    s.lastActive = now;
    this.send(ws, {
      type: "joined",
      name: player.name,
      token: player.token,
      creator: player.creator,
    });
    await this.save();
    this.broadcast();
    if (this.clip === null) this.ensureClip();
    // A match has no creator to start it; it begins once every seat has a
    // live socket.
    if (
      s.kind === "match" &&
      s.phase === "lobby" &&
      s.players.length > 0 &&
      s.players.every((p) => this.socketsOf(p.id).length > 0)
    )
      await this.begin(now);
  }

  private nameTaken(name: string) {
    const key = name.toLowerCase();
    return this.s!.players.some((p) => p.name.toLowerCase() === key);
  }

  private freeName(base: string) {
    if (!this.nameTaken(base)) return base;
    for (let n = 2; ; n += 1) {
      const name = `${base} ${n}`;
      if (!this.nameTaken(name)) return name;
    }
  }

  // The creator points the room at another category or difficulty between
  // games. Everyone stays seated and the room goes back to its lobby.
  async retarget(token: string, target: RoomTarget) {
    const s = this.s;
    if (s === undefined) return 404;
    if (s.kind !== "room" || token === "" || token !== s.creatorToken)
      return 403;
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
    s.lastActive = Date.now();
    await this.save();
    this.broadcast();
    return 204;
  }

  // Anyone seated may suggest between games. Suggesting what is already up
  // next votes for it; a player's new suggestion replaces their old one.
  async suggest(pid: string, slug: string, value: unknown) {
    const s = this.s;
    const mode = parseMode(value);
    if (s === undefined || s.kind !== "room" || s.phase !== "done") return;
    if (mode === null || !s.players.some((p) => p.id === pid)) return;
    const same = () =>
      s.suggestions?.find((x) => x.slug === slug && x.mode === mode);
    if (same() !== undefined) return this.vote(pid, same()!.id);
    // A personal mix would sit everyone in one player's taste.
    const category = await getCategory(this.env, slug).catch(() => null);
    if (category === null || category.feed === "mine") return;
    // Other messages may have run during the lookup.
    if (s.phase !== "done") return;
    if (same() !== undefined) return this.vote(pid, same()!.id);
    const kept = (s.suggestions ?? []).filter((x) => x.by !== pid);
    if (kept.length >= maxSuggestions) return;
    const id = base64url(crypto.getRandomValues(new Uint8Array(6)));
    kept.push({ id, slug, name: category.name, mode, by: pid, voters: [] });
    s.suggestions = kept;
    await this.vote(pid, id);
  }

  async vote(pid: string, id: string) {
    const s = this.s;
    if (s === undefined || s.phase !== "done") return;
    const list = s.suggestions ?? [];
    const target = list.find((x) => x.id === id);
    if (target === undefined || !s.players.some((p) => p.id === pid)) return;
    for (const x of list) x.voters = x.voters.filter((v) => v !== pid);
    target.voters.push(pid);
    s.lastActive = Date.now();
    await this.save();
    this.broadcast();
  }

  async start(pid: string, now: number) {
    const s = this.s;
    if (s === undefined) return;
    const player = s.players.find((p) => p.id === pid);
    if (player === undefined || !player.creator) return;
    await this.begin(now);
  }

  // Starts a fresh game in the room; a random id keeps its result rows
  // distinct from any earlier game played under a reused code.
  private async begin(now: number, picked?: "pick") {
    const s = this.s!;
    if (s.phase !== "lobby" && s.phase !== "done") return;
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
    s.candidates = shuffled(s.candidates);
    s.gameId = base64url(crypto.getRandomValues(new Uint8Array(8)));
    // A seat that never held a live socket did not play: the result rows
    // count who was there at the start, not who was invited.
    s.playedBy = s.players.filter(
      (p) => this.socketsOf(p.id).length > 0,
    ).length;
    s.next = 0;
    s.served = 0;
    s.round = null;
    s.reveal = null;
    s.retryAt = null;
    s.phase = "loading";
    s.lastActive = now;
    await this.save();
    this.broadcast();
    if (s.categorySlug !== "")
      await recordGameStart(
        this.env,
        {
          id: s.gameId,
          kind: s.kind,
          room: s.code,
          category: s.categorySlug,
          mode: s.mode,
          origin,
          players: s.playedBy,
        },
        Math.floor(now / 1000),
      ).catch((error) => console.error("room game log failed", error));
    await this.serveNext();
  }

  async answer(pid: string, value: string, now: number) {
    const s = this.s;
    if (s === undefined || s.phase !== "playing" || s.round === null) return;
    const player = s.players.find((p) => p.id === pid);
    if (player === undefined || s.round.answers[pid] !== undefined) return;
    const candidate = s.candidates[s.round.index];
    // The round's clock starts when the clip does; anything earlier is a
    // guess before anyone could hear it and does not count.
    if (now < s.round.startedAt) return;
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
    if (this.everyoneAnswered()) {
      await this.closeRound(now);
    }
    await this.save();
    this.broadcast();
  }

  private everyoneAnswered() {
    const s = this.s!;
    const waiting = [...this.connectedPids()].filter(
      (pid) => s.round!.answers[pid] === undefined,
    );
    return waiting.length === 0;
  }

  private async closeRound(now: number) {
    const s = this.s!;
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
      artist: round.credit ?? candidate.artist,
      cover: round.cover,
      link: round.link,
      until: now + revealMs,
      choices: round.choices,
      results: s.players.map((player) => {
        const answer = round.answers[player.id];
        return {
          name: player.name,
          answer: answer?.answer ?? null,
          correct: answer?.correct ?? false,
          score: answer?.score ?? 0,
          streak: player.streak,
        };
      }),
    };
    s.reveal = reveal;
    (s.history ??= []).push({
      number: reveal.number,
      title: reveal.title,
      original: reveal.original,
      artist: reveal.artist,
      cover: reveal.cover,
      link: reveal.link,
      results: reveal.results,
    });
    s.round = null;
    s.phase = "reveal";
    this.clip = null;
    // Recorded after the reveal is committed: a D1 await would otherwise
    // reopen the input gate for a re-entrant close, and a D1 failure must
    // not strand the room on the old round.
    await recordOutcomes(this.env, outcomes, Math.floor(now / 1000)).catch(
      (error) => console.error("room outcome write failed", error),
    );
  }

  // Resolves a clip for the next candidate and opens the round. A quota
  // answer keeps the same candidate and retries after a short wait; a
  // track with no resolvable preview is skipped.
  private async serveNext() {
    const s = this.s!;
    s.retryAt = null;
    while (s.next < s.candidates.length) {
      const index = s.next;
      s.next += 1;
      const candidate = s.candidates[index];
      let preview;
      try {
        preview = await candidatePreview(candidate);
      } catch (error) {
        if (error instanceof QuotaError) {
          s.next = index;
          s.retryAt = Date.now() + quotaRetryMs;
          await this.save();
          this.broadcast();
          return;
        }
        continue;
      }
      if (preview === null) continue;
      // The lead is measured from resolution, not from the request that
      // started it: lookups and skipped candidates can take longer than
      // the lead, and the clock must outlive the broadcast. The start is
      // provisional: devices that report the clip loaded pull it earlier.
      const served = Date.now();
      const startedAt = served + readyWaitMs + startLeadMs;
      s.round = {
        index,
        number: s.served + 1,
        servedAt: served,
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
      this.clip = preview.url;
      await this.save();
      this.broadcast();
      return;
    }
    s.phase = "done";
    s.round = null;
    await this.finish();
    await this.save();
    this.broadcast();
  }

  // A device reports its clip ready. The round starts at the earliest of
  // every connected player (and any screen) reporting, or the provisional
  // servedAt + readyWaitMs deadline, plus the usual lead.
  private async markLoaded(ws: WebSocket, now: number) {
    const s = this.s;
    if (s === undefined || s.phase !== "playing" || s.round === null) return;
    if (this.watching(ws)) {
      s.round.screenLoaded = true;
    } else {
      const pid = this.pidOf(ws);
      if (pid === undefined) return;
      if (!s.round.loaded.includes(pid)) s.round.loaded.push(pid);
    }
    if (this.maybeStartEarly(now)) {
      await this.save();
      this.broadcast();
    }
  }

  // True when everyone expected has reported; moves the start up if the
  // wait can end early. Safe to call on any state change.
  private maybeStartEarly(now: number) {
    const s = this.s;
    if (s === undefined) return false;
    const round = s.round;
    if (s.phase !== "playing" || round === null) return false;
    const expected = this.connectedPids();
    if (![...expected].every((pid) => round.loaded.includes(pid))) return false;
    if (this.hasScreen() && !round.screenLoaded) return false;
    const start = now + startLeadMs;
    if (start >= round.startedAt) return false;
    round.startedAt = start;
    round.endsAt = start + roundSeconds * 1000;
    return true;
  }

  // After an eviction the clip is gone; re-resolve the open round for
  // players who reconnect, without touching the round's clock.
  private ensureClip() {
    const s = this.s;
    if (s === undefined || s.phase !== "playing" || s.round === null) return;
    const index = s.round.index;
    const candidate = s.candidates[index];
    this.ctx.waitUntil(
      candidatePreview(candidate)
        .then((preview) => {
          // The lookup may resolve after the round moved on; an index that
          // no longer matches must not overwrite the new clip.
          if (
            preview === null ||
            this.s?.phase !== "playing" ||
            this.s.round?.index !== index
          )
            return;
          this.clip = preview.url;
          this.broadcast();
        })
        .catch(() => undefined),
    );
  }

  // Writes one row per signed-in player when the game finishes. Guests and
  // games that never served a round write nothing; the row id makes a
  // repeated finish a no-op.
  private async recordResults() {
    const s = this.s!;
    if (s.served === 0 || s.categorySlug === "" || s.gameId === "") return;
    const ordered = [...s.players].sort((a, b) => b.score - a.score);
    const rows: ResultRow[] = [];
    for (const player of ordered) {
      if (player.userId === null) continue;
      const rank = 1 + ordered.filter((p) => p.score > player.score).length;
      rows.push({
        id: `r:${s.gameId}:${player.userId}`,
        userId: player.userId,
        finishedAt: Math.floor(Date.now() / 1000),
        category: s.categorySlug,
        kind: s.kind,
        score: player.score,
        rank,
        players: s.playedBy === 0 ? s.players.length : s.playedBy,
        correct: player.correct ?? 0,
        rounds: s.served,
      });
    }
    await recordResults(this.env, rows);
  }

  // A finish also freezes the category board for the final standings, so a
  // later snapshot — even after an eviction — shows the same board without
  // another D1 read.
  private async finish() {
    const s = this.s!;
    await this.recordResults();
    s.board =
      s.categorySlug === ""
        ? []
        : await readCategoryBoard(this.env, s.categorySlug).catch(() => []);
  }

  private async nextPhase() {
    const s = this.s!;
    if (s.served >= roundsPerGame || s.next >= s.candidates.length) {
      s.phase = "done";
      s.reveal = null;
      await this.finish();
      await this.save();
      this.broadcast();
      return;
    }
    s.phase = "loading";
    await this.serveNext();
  }

  async alarm() {
    await this.tick(Date.now());
  }

  async tick(now: number) {
    const s = this.s;
    if (s === undefined) return;
    if (now - s.lastActive >= idleMs) {
      // An hour without client action ends the room whoever is connected;
      // 1001 tells each page to show the closed state instead of retrying.
      this.s = undefined;
      for (const ws of this.ctx.getWebSockets()) ws.close(1001, "room closed");
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (
      s.kind === "match" &&
      s.phase === "lobby" &&
      now >= s.seededAt + matchWaitMs &&
      this.connectedPids().size > 0
    ) {
      await this.begin(now);
      return;
    }
    if (s.phase === "playing" && s.round !== null && now >= s.round.endsAt) {
      await this.closeRound(now);
      await this.save();
      this.broadcast();
    } else if (
      s.phase === "reveal" &&
      s.reveal !== null &&
      now >= s.reveal.until
    ) {
      await this.nextPhase();
    } else if (
      s.phase === "loading" &&
      s.retryAt !== null &&
      now >= s.retryAt
    ) {
      await this.serveNext();
    } else {
      await this.schedule();
    }
  }
}
