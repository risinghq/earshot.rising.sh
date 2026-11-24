import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { catalog, enoughTracks, getCategory } from "../catalog/catalog";
import {
  MatchHost,
  type MatchPorts,
  type MatchSocket,
  type Seat,
} from "./host";
import { readMatchMessage } from "../room/messages";
import { byDecade } from "../catalog/pool";
import { newRoomCode, newRoomSecret } from "../room/room";
import type { Candidate } from "../catalog/sources";

// One global object serialises the queue. Its whole state is the attachment
// of each waiting socket, so hibernation never loses a queued player and a
// closed socket leaves the queue by itself.
export class Matchmaker extends DurableObject<Env> {
  private readonly host = new MatchHost(this.ports());

  private ports(): MatchPorts {
    return {
      now: () => Date.now(),
      sockets: () => this.ctx.getWebSockets().map(matchSocket),
      pool: (slug, era) => this.pool(slug, era),
      openRoom: async (init) => {
        const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(init.code));
        const response = await room.fetch(
          new Request("https://room/init", {
            method: "POST",
            body: JSON.stringify(init),
          }),
        );
        return response.ok;
      },
      newCode: newRoomCode,
      newSecret: newRoomSecret,
    };
  }

  private async pool(slug: string, era: number | null) {
    const category = await getCategory(this.env, slug);
    if (category === null) return null;
    let candidates: Candidate[];
    try {
      // A match never plays a personal chart: 'mine' is refused at the
      // routes, so the catalog is resolved without a user.
      candidates = await catalog(this.env, category, null);
    } catch {
      return null;
    }
    if (era !== null) candidates = byDecade(candidates, era);
    if (!enoughTracks(category, candidates)) return null;
    return { slug: category.slug, name: category.name, candidates };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws")
      return new Response("not found", { status: 404 });
    const uid = Number(url.searchParams.get("u"));
    const era = Number(url.searchParams.get("e"));
    const seat: Seat = {
      category: url.searchParams.get("category") ?? "",
      era: Number.isInteger(era) && era > 0 ? era : null,
      // The Worker read the session and set `u` and `n`; a client cannot
      // reach this handler except through that route.
      uid: Number.isInteger(uid) && uid > 0 ? uid : null,
      anon: url.searchParams.get("a"),
      name: url.searchParams.get("n") ?? "",
      queued: 0,
    };
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(seat);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const message = readMatchMessage(raw);
    if (message !== null) await this.host.join(matchSocket(ws), message);
  }
}

function matchSocket(ws: WebSocket): MatchSocket {
  return {
    seat: () => ws.deserializeAttachment() as Seat | null,
    setSeat: (seat) => ws.serializeAttachment(seat),
    send: (message) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // A closing socket leaves the queue by itself.
      }
    },
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
}
