// Runs a room: turns socket messages and deadlines into rule calls, saves,
// broadcasts and records. Everything outside the room — the clock, the
// sockets, storage, the alarm, Deezer, D1 — comes in through RoomPorts, so
// the Durable Object supplies the real ones and a test supplies fakes.
import type { Category } from "../catalog/catalog";
import type { GameStart, Outcome } from "../game/outcomes";
import { closeCodes, type ServerMessage } from "./protocol";
import type { CategoryBoardEntry, ResultRow } from "../game/results";
import type { readClientMessage } from "./messages";
import type { Mode } from "../game/rules";
import { QuotaError, type Candidate, type Preview } from "../catalog/sources";
import * as game from "./game";
import type { Presence, RoomInit, RoomTarget, Stored } from "./game";

export type ClientMessage = NonNullable<ReturnType<typeof readClientMessage>>;

export interface SocketInfo {
  pid?: string;
  uid?: number;
  // The signed-in user's name, which seats them without a nickname.
  name?: string;
  anon?: string;
  watch?: boolean;
}

export interface Socket {
  info(): SocketInfo;
  setInfo(info: SocketInfo): void;
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface RoomPorts {
  now(): number;
  sockets(): Socket[];
  save(s: Stored): Promise<void>;
  erase(): Promise<void>;
  setAlarm(at: number): Promise<void>;
  // Work that may finish after the current event, such as a clip lookup.
  background(work: Promise<unknown>): void;
  newId(): string;
  newSecret(): string;
  preview(candidate: Candidate): Promise<Preview | null>;
  category(slug: string): Promise<Category | null>;
  recordGameStart(start: GameStart, nowSec: number): Promise<void>;
  recordOutcomes(rows: Outcome[], nowSec: number): Promise<void>;
  recordResults(rows: ResultRow[]): Promise<void>;
  readBoard(slug: string): Promise<CategoryBoardEntry[]>;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

export class RoomHost {
  // The signed preview URL lives in memory only; it is never written to
  // storage. An evicted object re-resolves it for players who reconnect.
  private clip: string | null = null;

  constructor(
    private readonly ports: RoomPorts,
    private s: Stored | undefined,
  ) {
    if (s !== undefined) game.upgrade(s);
  }

  get exists() {
    return this.s !== undefined;
  }

  async init(init: RoomInit) {
    if (this.s !== undefined) return false;
    this.s = game.createRoom(init, this.ports.now(), () => this.ports.newId());
    await this.save();
    return true;
  }

  async message(socket: Socket, message: ClientMessage) {
    const now = this.ports.now();
    if (message.type === "watch") return this.watch(socket, now);
    if (message.type === "join")
      return this.join(socket, message.name, message.token, now);
    if (message.type === "loaded") return this.loaded(socket, now);
    // The rest act for a seated player.
    const pid = socket.info().pid;
    const s = this.s;
    if (pid === undefined || s === undefined) return;
    switch (message.type) {
      case "start":
        if (game.canStart(s, pid)) await this.begin(now);
        return;
      case "answer":
        if (!game.answer(s, pid, message.answer, now)) return;
        if (game.everyoneAnswered(s, this.presence()))
          await this.closeRound(now);
        return this.commit();
      case "suggest":
        return this.suggest(pid, message.category, message.mode);
      case "vote":
        if (game.vote(s, pid, message.id, now)) await this.commit();
        return;
    }
  }

  // The departed player no longer counts toward the round; if they were the
  // last one unanswered, the round closes as an answer would. Their missing
  // "loaded" report stops counting the same way.
  async left() {
    const s = this.s;
    if (s === undefined) return;
    const now = this.ports.now();
    const presence = this.presence();
    if (s.phase === "playing" && game.everyoneAnswered(s, presence)) {
      await this.closeRound(now);
      await this.save();
    } else if (game.startEarly(s, now, presence)) {
      await this.save();
    }
    this.broadcast();
  }

  // The creator points the room at another category between games. Picked
  // from Up next, the game starts at once: everyone is seated and their
  // sound already works.
  async retarget(token: string, target: RoomTarget, start: boolean) {
    const s = this.s;
    if (s === undefined) return 404;
    const now = this.ports.now();
    const status = game.retarget(s, token, target, now);
    if (status !== 204) return status;
    await this.commit();
    if (start) await this.begin(now, "pick");
    return status;
  }

  async alarm() {
    const s = this.s;
    if (s === undefined) return;
    const now = this.ports.now();
    switch (game.dueAt(s, now, this.presence())) {
      case "expire":
        // 1001 tells each page to show the closed state instead of retrying.
        this.s = undefined;
        for (const socket of this.ports.sockets())
          socket.close(closeCodes.gone, "room closed");
        return this.ports.erase();
      case "begin":
        return this.begin(now);
      case "close":
        await this.closeRound(now);
        return this.commit();
      case "advance":
        if (game.gameOver(s)) return this.finish();
        s.phase = "loading";
        return this.serveNext();
      case "retry":
        return this.serveNext();
      case null:
        return this.schedule();
    }
  }

  private presence(): Presence {
    const connected = new Set<string>();
    let screen = false;
    for (const socket of this.ports.sockets()) {
      const info = socket.info();
      if (info.watch === true) screen = true;
      if (info.pid !== undefined) connected.add(info.pid);
    }
    return { connected, screen };
  }

  private broadcast() {
    const s = this.s;
    if (s === undefined) return;
    const presence = this.presence();
    const now = this.ports.now();
    for (const socket of this.ports.sockets()) {
      const info = socket.info();
      if (info.watch === true)
        socket.send(game.snapshot(s, undefined, presence, this.clip, now));
      else if (info.pid !== undefined)
        socket.send(game.snapshot(s, info.pid, presence, this.clip, now));
    }
  }

  private async save() {
    if (this.s === undefined) return;
    await this.ports.save(this.s);
    await this.schedule();
  }

  async schedule() {
    if (this.s === undefined) return;
    const due = game.nextDue(this.s, this.ports.now(), this.presence());
    if (due !== null) await this.ports.setAlarm(due);
  }

  private async commit() {
    await this.save();
    this.broadcast();
  }

  private refuseGone(socket: Socket) {
    socket.send({ type: "error", code: "gone" });
    socket.close(1000, "room closed");
  }

  // A screen opens as a viewer: it holds no seat and scores nothing.
  private watch(socket: Socket, now: number) {
    const s = this.s;
    if (s === undefined) return this.refuseGone(socket);
    socket.setInfo({ ...socket.info(), watch: true });
    socket.send(game.snapshot(s, undefined, this.presence(), this.clip, now));
    // The players' snapshots change too: from now on the clip is the
    // screen's, so their next state carries no URL.
    this.broadcast();
    if (this.clip === null) this.ensureClip();
  }

  private async join(
    socket: Socket,
    name: string | undefined,
    token: string | undefined,
    now: number,
  ) {
    const s = this.s;
    if (s === undefined) return this.refuseGone(socket);
    const info = socket.info();
    const result = game.seat(
      s,
      {
        token,
        uid: info.uid ?? null,
        signedName: info.name ?? "",
        typed: name ?? "",
        anon: info.anon ?? null,
      },
      now,
      { id: this.ports.newId(), token: this.ports.newSecret() },
    );
    if (!result.ok) {
      if (result.preview) socket.send(game.preview(s));
      socket.send({ type: "error", code: result.code });
      return;
    }
    const { player } = result;
    // A guest who signs in after the game writes the result held back.
    if (result.claimed && s.phase === "done") {
      await this.recordResults();
      s.board = await this.board(s.board);
    }
    // A seat plays on one device. Joining from another moves it there: the
    // device that held it is told, drops the seat and stops reconnecting.
    for (const other of this.ports.sockets()) {
      if (other === socket || other.info().pid !== player.id) continue;
      other.send({ type: "moved" });
      other.setInfo({ ...other.info(), pid: undefined });
      other.close(closeCodes.moved, "seat moved");
    }
    socket.setInfo({ ...info, pid: player.id });
    socket.send({
      type: "joined",
      name: player.name,
      token: player.token,
      creator: player.creator,
    });
    await this.commit();
    if (this.clip === null) this.ensureClip();
    if (game.matchFilled(s, this.presence())) await this.begin(now);
  }

  // Suggesting what is already up next votes for it.
  private async suggest(pid: string, slug: string, mode: Mode) {
    const s = this.s!;
    if (!game.canSuggest(s, pid)) return;
    const same = game.suggestionFor(s, slug, mode);
    if (same !== undefined) {
      if (game.vote(s, pid, same.id, this.ports.now())) await this.commit();
      return;
    }
    // A personal mix would sit everyone in one player's taste.
    const category = await this.ports.category(slug).catch(() => null);
    if (category === null || category.feed === "mine") return;
    // Other messages may have run during the lookup; the rule checks again.
    const changed = game.suggest(
      s,
      pid,
      { slug, name: category.name, mode },
      this.ports.newId(),
      this.ports.now(),
    );
    if (changed) await this.commit();
  }

  private async loaded(socket: Socket, now: number) {
    const s = this.s;
    if (s === undefined) return;
    const info = socket.info();
    const who = info.watch === true ? "screen" : info.pid;
    if (who === undefined || !game.markLoaded(s, who)) return;
    if (game.startEarly(s, now, this.presence())) await this.commit();
  }

  private async begin(now: number, picked?: "pick") {
    const s = this.s!;
    const started = game.begin(
      s,
      now,
      this.presence(),
      this.ports.newId(),
      picked,
    );
    if (started === null) return;
    await this.commit();
    if (s.categorySlug !== "")
      await this.ports
        .recordGameStart(started, seconds(now))
        .catch((error) => console.error("room game log failed", error));
    await this.serveNext();
  }

  private async closeRound(now: number) {
    const outcomes = game.closeRound(this.s!, now);
    this.clip = null;
    // Recorded after the reveal is in memory: a D1 await reopens the input
    // gate for a re-entrant close, and a D1 failure must not strand the room
    // on the old round.
    await this.ports
      .recordOutcomes(outcomes, seconds(now))
      .catch((error) => console.error("room outcome write failed", error));
  }

  // Resolves a clip for the next candidate and opens the round. A quota
  // answer holds the candidate for a retry; a track with no resolvable
  // preview is skipped.
  private async serveNext() {
    const s = this.s!;
    for (
      let index = game.takeCandidate(s);
      index !== null;
      index = game.takeCandidate(s)
    ) {
      let preview;
      try {
        preview = await this.ports.preview(s.candidates[index]);
      } catch (error) {
        if (!(error instanceof QuotaError)) continue;
        // Stamped after the lookup, so a slow answer cannot leave a retry
        // time already in the past.
        game.holdForQuota(s, index, this.ports.now());
        return this.commit();
      }
      if (preview === null) continue;
      game.openRound(s, index, preview, this.ports.now());
      this.clip = preview.url;
      return this.commit();
    }
    await this.finish();
  }

  // After an eviction the clip is gone; re-resolve the open round for
  // players who reconnect, without touching the round's clock.
  private ensureClip() {
    const s = this.s;
    if (s === undefined || s.phase !== "playing" || s.round === null) return;
    const index = s.round.index;
    this.ports.background(
      this.ports
        .preview(s.candidates[index])
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

  private recordResults() {
    return this.ports.recordResults(
      game.resultRows(this.s!, seconds(this.ports.now())),
    );
  }

  private async board(fallback: CategoryBoardEntry[]) {
    const slug = this.s!.categorySlug;
    if (slug === "") return [];
    return this.ports.readBoard(slug).catch(() => fallback);
  }

  // A finish also freezes the category board for the final standings, so a
  // later snapshot — even after an eviction — shows the same board without
  // another D1 read.
  private async finish() {
    const s = this.s!;
    game.endGame(s);
    await this.recordResults();
    s.board = await this.board([]);
    await this.commit();
  }
}
