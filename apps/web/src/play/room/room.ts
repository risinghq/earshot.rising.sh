// The Durable Object that hosts a room. It supplies the real clock, sockets,
// storage, alarm, Deezer and D1 to RoomHost, which runs the room.
import { DurableObject } from "cloudflare:workers";
import { base64url } from "../../account/auth";
import type { Env } from "../../env";
import { candidatePreview, parseMode } from "../game/quiz";
import type { RoomKind } from "./protocol";
import { readCategoryBoard, recordResults } from "../game/results";
import type { Candidate } from "../catalog/sources";
import { recordGameStart, recordOutcomes } from "../game/outcomes";
import { getCategory } from "../catalog/catalog";
import { readClientMessage } from "./messages";
import {
  seatedOk,
  type RoomTarget,
  type SeatedPlayer,
  type Stored,
} from "./game";
import { RoomHost, type RoomPorts, type Socket, type SocketInfo } from "./host";

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

const newId = () => base64url(crypto.getRandomValues(new Uint8Array(8)));

const storageKey = "room";

// A hibernatable socket keeps its seat in the attachment, so the seat
// survives the object being evicted between messages. One wrapper per
// socket, because RoomHost tells sockets apart by identity.
const wrappers = new WeakMap<WebSocket, Socket>();

function socketOf(ws: WebSocket): Socket {
  let socket = wrappers.get(ws);
  if (socket === undefined) {
    socket = wrap(ws);
    wrappers.set(ws, socket);
  }
  return socket;
}

function wrap(ws: WebSocket): Socket {
  return {
    info: () => (ws.deserializeAttachment() as SocketInfo | null) ?? {},
    setInfo: (info) => ws.serializeAttachment(info),
    send: (message) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // A dying socket is dropped by the close handler.
      }
    },
    close: (code, reason) => ws.close(code, reason),
  };
}

export class Room extends DurableObject<Env> {
  private host!: RoomHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<Stored>(storageKey);
      this.host = new RoomHost(this.ports(), stored);
      if (stored !== undefined && (await ctx.storage.getAlarm()) === null)
        await this.host.schedule();
    });
  }

  private ports(): RoomPorts {
    const { ctx, env } = this;
    return {
      now: () => Date.now(),
      sockets: () => ctx.getWebSockets().map(socketOf),
      save: (s) => ctx.storage.put(storageKey, s),
      erase: async () => {
        await ctx.storage.deleteAll();
        await ctx.storage.deleteAlarm();
      },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      background: (work) => ctx.waitUntil(work),
      newId,
      newSecret: newRoomSecret,
      preview: candidatePreview,
      category: (slug) => getCategory(env, slug),
      recordGameStart: (start, at) => recordGameStart(env, start, at),
      recordOutcomes: (rows, at) => recordOutcomes(env, rows, at),
      recordResults: (rows) => recordResults(env, rows),
      readBoard: (slug) => readCategoryBoard(env, slug),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as {
        code?: string;
        kind?: RoomKind;
        categorySlug?: string;
        categoryName?: string;
        mode?: string;
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
      const created = await this.host.init({
        code: body.code,
        kind: body.kind ?? "room",
        categorySlug: body.categorySlug,
        categoryName: body.categoryName,
        mode,
        candidates: body.candidates,
        creatorToken: body.creatorToken,
        players: body.players ?? [],
      });
      return created
        ? Response.json({ ok: true })
        : Response.json({ error: "room already exists" }, { status: 409 });
    }
    if (url.pathname === "/exists")
      return new Response(null, { status: this.host.exists ? 200 : 404 });
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
      const status = await this.host.retarget(
        body.token ?? "",
        {
          categorySlug: body.categorySlug,
          categoryName: body.categoryName,
          mode,
          candidates: body.candidates,
        },
        body.start === true,
      );
      return new Response(null, { status });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const message = readClientMessage(raw);
    if (message !== null) await this.host.message(socketOf(ws), message);
  }

  // A socket that errors is gone the same as one that closed.
  async webSocketClose() {
    await this.host.left();
  }

  async webSocketError() {
    await this.host.left();
  }

  async alarm() {
    await this.host.alarm();
  }
}
