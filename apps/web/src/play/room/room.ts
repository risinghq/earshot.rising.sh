// The Durable Object that hosts a room. It supplies the real clock, sockets,
// storage, alarm, Deezer and D1 to RoomHost, which runs the room.
import { DurableObject } from "cloudflare:workers";
import { base64url } from "../../account/auth";
import type { Env } from "../../env";
import { candidatePreview } from "../game/quiz";
import { readCategoryBoard, recordResults } from "../game/results";
import {
  playerKeyOf,
  recordGameStart,
  recordOutcomes,
  trackKeyFor,
} from "../game/outcomes";
import { drawWeights, weightedShuffle } from "../game/rating";
import { database } from "../../platform/db";
import { getCategory } from "../catalog/catalog";
import { readClientMessage } from "./messages";
import type { RoomInit, RoomTarget, Stored } from "./game";
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
      weightedDraw: async (players, candidates, mode, category) => {
        const items = candidates.map((track) => ({
          key: trackKeyFor(track),
          category,
        }));
        const weights = await drawWeights(
          database(env.DB),
          players.map((player) => playerKeyOf(player.userId, player.anon)),
          items,
          mode,
        );
        return weightedShuffle(candidates, (_, index) => weights[index] ?? 1);
      },
      recordResults: (rows) => recordResults(env, rows),
      readBoard: (slug) => readCategoryBoard(env, slug),
    };
  }

  // False when a room already holds this code.
  init(init: RoomInit): Promise<boolean> {
    return this.host.init(init);
  }

  exists(): boolean {
    return this.host.exists;
  }

  retarget(token: string, target: RoomTarget, start: boolean) {
    return this.host.retarget(token, target, start);
  }

  // Only the WebSocket upgrade comes through fetch, because RPC cannot
  // return a socket pair.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
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
