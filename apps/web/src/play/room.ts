// The Durable Object that hosts a room. It owns the sockets, the stored
// room, the alarm, and the calls to D1 and Deezer; the rules live in
// room-game.ts and take who is present and the time from here.
import { DurableObject } from "cloudflare:workers";
import { base64url } from "../auth";
import type { Env } from "../types";
import type { Mode } from "./quiz";
import { candidatePreview, parseMode } from "./quiz";
import { closeCodes, type RoomKind, type ServerMessage } from "./protocol";
import { readCategoryBoard, recordResults } from "./results";
import { QuotaError, type Candidate } from "./sources";
import { recordGameStart, recordOutcomes } from "./outcomes";
import { getCategory } from "./catalog";
import { readClientMessage } from "./messages";
import * as game from "./room-game";
import type { Presence, RoomTarget, SeatedPlayer, Stored } from "./room-game";

export const roomCodeLength = 6;
// No 0/O, 1/I/L, so the code reads unambiguously out loud.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

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

const newId = (bytes: number) =>
  base64url(crypto.getRandomValues(new Uint8Array(bytes)));

interface SocketInfo {
  pid?: string;
  uid?: number;
  // The signed-in user's name, which seats them without a nickname.
  name?: string;
  anon?: string;
  watch?: boolean;
}

const storageKey = "room";

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
        game.upgrade(this.s);
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
        (body.players !== undefined && !game.seatedOk(body.players))
      )
        return Response.json({ error: "bad init" }, { status: 400 });
      this.s = game.createRoom(
        {
          code: body.code,
          kind: body.kind ?? "room",
          categorySlug: body.categorySlug,
          categoryName: body.categoryName,
          mode,
          candidates: body.candidates,
          creatorToken: body.creatorToken,
          players: body.players ?? [],
        },
        Date.now(),
        () => newId(8),
      );
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
    const message = readClientMessage(raw);
    if (message === null) return;
    const now = Date.now();
    if (message.type === "watch") return this.watch(ws);
    if (message.type === "join")
      return this.join(ws, message.name, message.token, now);
    if (message.type === "loaded") return this.markLoaded(ws, now);
    // The rest act for a seated player.
    const pid = this.infoOf(ws).pid;
    if (pid === undefined) return;
    switch (message.type) {
      case "start":
        return this.start(pid, now);
      case "answer":
        return this.answer(pid, message.answer, now);
      case "suggest":
        return this.suggest(pid, message.category, message.mode);
      case "vote":
        return this.vote(pid, message.id);
    }
  }

  async webSocketClose() {
    const s = this.s;
    if (s === undefined) return;
    const now = Date.now();
    // The departed player no longer counts toward the round; if they were
    // the last one unanswered, close it early like an answer would. Their
    // missing "loaded" report stops counting the same way.
    const presence = this.presence();
    if (s.phase === "playing" && game.everyoneAnswered(s, presence)) {
      await this.closeRound(now);
      await this.save();
    } else if (game.startEarly(s, now, presence)) {
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

  private presence(): Presence {
    const connected = new Set<string>();
    let screen = false;
    for (const ws of this.ctx.getWebSockets()) {
      const info = this.infoOf(ws);
      if (info.watch === true) screen = true;
      if (info.pid !== undefined) connected.add(info.pid);
    }
    return { connected, screen };
  }

  private send(ws: WebSocket, value: ServerMessage) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      // A dying socket is dropped by the close handler.
    }
  }

  private broadcast() {
    const s = this.s;
    if (s === undefined) return;
    const presence = this.presence();
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const info = this.infoOf(ws);
      if (info.watch === true)
        this.send(ws, game.snapshot(s, undefined, presence, this.clip, now));
      else if (info.pid !== undefined)
        this.send(ws, game.snapshot(s, info.pid, presence, this.clip, now));
    }
  }

  private async save() {
    if (this.s === undefined) return;
    await this.ctx.storage.put(storageKey, this.s);
    await this.schedule();
  }

  private async schedule() {
    if (this.s === undefined) return;
    const due = game.nextDue(this.s, Date.now(), this.presence());
    if (due !== null) await this.ctx.storage.setAlarm(due);
  }

  private refuseGone(ws: WebSocket) {
    this.send(ws, { type: "error", code: "gone" });
    ws.close(1000, "room closed");
  }

  // A screen opens as a viewer: it holds no seat and scores nothing.
  async watch(ws: WebSocket) {
    const s = this.s;
    if (s === undefined) return this.refuseGone(ws);
    ws.serializeAttachment({
      ...this.infoOf(ws),
      watch: true,
    } satisfies SocketInfo);
    this.send(
      ws,
      game.snapshot(s, undefined, this.presence(), this.clip, Date.now()),
    );
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
    if (s === undefined) return this.refuseGone(ws);
    const info = this.infoOf(ws);
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
      { id: newId(8), token: newRoomSecret() },
    );
    if (!result.ok) {
      if (result.preview) this.send(ws, game.preview(s));
      this.send(ws, { type: "error", code: result.code });
      return;
    }
    const { player } = result;
    if (result.claimed && s.phase === "done") {
      await this.recordResults();
      s.board =
        s.categorySlug === ""
          ? []
          : await readCategoryBoard(this.env, s.categorySlug).catch(
              () => s.board,
            );
    }
    // A seat plays on one device. Joining from another moves it there: the
    // device that held it is told, drops the seat and stops reconnecting.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws || this.infoOf(other).pid !== player.id) continue;
      this.send(other, { type: "moved" });
      other.serializeAttachment({ ...this.infoOf(other), pid: undefined });
      other.close(closeCodes.moved, "seat moved");
    }
    ws.serializeAttachment({ ...info, pid: player.id } satisfies SocketInfo);
    this.send(ws, {
      type: "joined",
      name: player.name,
      token: player.token,
      creator: player.creator,
    });
    await this.save();
    this.broadcast();
    if (this.clip === null) this.ensureClip();
    if (game.matchFilled(s, this.presence())) await this.begin(now);
  }

  async retarget(token: string, target: RoomTarget) {
    const s = this.s;
    if (s === undefined) return 404;
    const status = game.retarget(s, token, target, Date.now());
    if (status !== 204) return status;
    await this.save();
    this.broadcast();
    return status;
  }

  // Anyone seated may suggest between games. Suggesting what is already up
  // next votes for it.
  async suggest(pid: string, slug: string, mode: Mode) {
    const s = this.s;
    if (s === undefined || !game.canSuggest(s, pid)) return;
    const same = game.suggestionFor(s, slug, mode);
    if (same !== undefined) return this.vote(pid, same.id);
    // A personal mix would sit everyone in one player's taste.
    const category = await getCategory(this.env, slug).catch(() => null);
    if (category === null || category.feed === "mine") return;
    // Other messages may have run during the lookup; the rule checks again.
    const changed = game.suggest(
      s,
      pid,
      { slug, name: category.name, mode },
      newId(6),
      Date.now(),
    );
    if (changed) await this.commit();
  }

  async vote(pid: string, id: string) {
    const s = this.s;
    if (s === undefined) return;
    if (game.vote(s, pid, id, Date.now())) await this.commit();
  }

  async start(pid: string, now: number) {
    const s = this.s;
    if (s === undefined || !game.canStart(s, pid)) return;
    await this.begin(now);
  }

  private async commit() {
    await this.save();
    this.broadcast();
  }

  private async begin(now: number, picked?: "pick") {
    const s = this.s!;
    const started = game.begin(s, now, this.presence(), newId(8), picked);
    if (started === null) return;
    await this.commit();
    if (s.categorySlug !== "")
      await recordGameStart(this.env, started, Math.floor(now / 1000)).catch(
        (error) => console.error("room game log failed", error),
      );
    await this.serveNext();
  }

  async answer(pid: string, value: string, now: number) {
    const s = this.s;
    if (s === undefined || !game.answer(s, pid, value, now)) return;
    if (game.everyoneAnswered(s, this.presence())) await this.closeRound(now);
    await this.commit();
  }

  private async closeRound(now: number) {
    const outcomes = game.closeRound(this.s!, now);
    this.clip = null;
    // Recorded after the reveal is committed: a D1 await would otherwise
    // reopen the input gate for a re-entrant close, and a D1 failure must
    // not strand the room on the old round.
    await recordOutcomes(this.env, outcomes, Math.floor(now / 1000)).catch(
      (error) => console.error("room outcome write failed", error),
    );
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
        preview = await candidatePreview(s.candidates[index]);
      } catch (error) {
        if (!(error instanceof QuotaError)) continue;
        game.holdForQuota(s, index, Date.now());
        return this.commit();
      }
      if (preview === null) continue;
      game.openRound(s, index, preview, Date.now());
      this.clip = preview.url;
      return this.commit();
    }
    await this.finish();
  }

  private async markLoaded(ws: WebSocket, now: number) {
    const s = this.s;
    if (s === undefined) return;
    const info = this.infoOf(ws);
    const who = info.watch === true ? "screen" : info.pid;
    if (who === undefined || !game.markLoaded(s, who)) return;
    if (game.startEarly(s, now, this.presence())) await this.commit();
  }

  // After an eviction the clip is gone; re-resolve the open round for
  // players who reconnect, without touching the round's clock.
  private ensureClip() {
    const s = this.s;
    if (s === undefined || s.phase !== "playing" || s.round === null) return;
    const index = s.round.index;
    this.ctx.waitUntil(
      candidatePreview(s.candidates[index])
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

  private async recordResults() {
    await recordResults(
      this.env,
      game.resultRows(this.s!, Math.floor(Date.now() / 1000)),
    );
  }

  // A finish also freezes the category board for the final standings, so a
  // later snapshot — even after an eviction — shows the same board without
  // another D1 read.
  private async finish() {
    const s = this.s!;
    game.endGame(s);
    await this.recordResults();
    s.board =
      s.categorySlug === ""
        ? []
        : await readCategoryBoard(this.env, s.categorySlug).catch(() => []);
    await this.commit();
  }

  async alarm() {
    await this.tick(Date.now());
  }

  async tick(now: number) {
    const s = this.s;
    if (s === undefined) return;
    switch (game.dueAt(s, now, this.presence())) {
      case "expire":
        // 1001 tells each page to show the closed state instead of retrying.
        this.s = undefined;
        for (const ws of this.ctx.getWebSockets())
          ws.close(closeCodes.gone, "room closed");
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return;
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
}
