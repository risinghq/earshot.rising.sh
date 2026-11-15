import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { catalog, getCategory } from "./catalog";
import { newRoomCode, newRoomSecret, nicknameMaxLength } from "./room";
import type { Candidate } from "./sources";

// One global object serialises the queue. Its whole state is the attachment
// of each waiting socket, so hibernation never loses a queued player and a
// closed socket leaves the queue by itself.
interface Seat {
  category: string;
  uid: number | null;
  name: string;
  queued: number;
}

const pairing = -1;

export class Matchmaker extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws")
      return new Response("not found", { status: 404 });
    const category = url.searchParams.get("category") ?? "";
    const uid = Number(url.searchParams.get("u"));
    const seat: Seat = {
      category,
      // The Worker read the session and set `u` and `n`; a client cannot
      // reach this handler except through that route.
      uid: Number.isInteger(uid) && uid > 0 ? uid : null,
      name: url.searchParams.get("n") ?? "",
      queued: 0,
    };
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(seat);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private seat(ws: WebSocket) {
    return ws.deserializeAttachment() as Seat | null;
  }

  private send(ws: WebSocket, value: unknown) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      // A dying socket is dropped by the close handler.
    }
  }

  private waiting() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, seat: this.seat(ws) }))
      .filter(
        (entry): entry is { ws: WebSocket; seat: Seat } =>
          entry.seat !== null && entry.seat.queued > 0,
      )
      .sort((a, b) => a.seat.queued - b.seat.queued);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let message: { type?: string; name?: unknown };
    try {
      message = JSON.parse(typeof raw === "string" ? raw : "");
    } catch {
      return;
    }
    if (message.type !== "join") return;
    const seat = this.seat(ws);
    if (seat === null || seat.queued !== 0) return;
    let name = seat.name;
    if (seat.uid === null) {
      name = typeof message.name === "string" ? message.name.trim() : "";
      if (name === "" || [...name].length > nicknameMaxLength) {
        this.send(ws, { type: "error", code: "name" });
        return;
      }
      seat.name = name;
    }
    await this.enqueue(ws, seat, true);
  }

  // Queues the seat behind the other same-category waiters, or pairs it with
  // the oldest one. A seat coming back from a dead pair keeps its place in
  // line and is never refused for a name it already waited with.
  private async enqueue(ws: WebSocket, seat: Seat, refuseTaken: boolean) {
    const sameCategory = this.waiting().filter(
      (entry) => entry.seat.category === seat.category,
    );
    const partner = sameCategory.find(
      (entry) => entry.seat.name.toLowerCase() !== seat.name.toLowerCase(),
    );
    if (partner === undefined) {
      if (refuseTaken && sameCategory.length > 0) {
        this.send(ws, { type: "error", code: "taken" });
        return;
      }
      if (seat.queued <= 0) seat.queued = Date.now();
      ws.serializeAttachment(seat);
      this.send(ws, { type: "queued" });
      return;
    }
    await this.pair(partner.ws, partner.seat, ws, seat);
  }

  private async pair(a: WebSocket, seatA: Seat, b: WebSocket, seatB: Seat) {
    const queuedA = seatA.queued;
    const queuedB = seatB.queued;
    seatA.queued = pairing;
    a.serializeAttachment(seatA);
    seatB.queued = pairing;
    b.serializeAttachment(seatB);
    // Either socket may die during the awaits below; a seat left marked
    // `pairing` never re-queues itself, so a survivor goes back through
    // enqueue and can match the next waiter instead of waiting forever.
    const rescue = async () => {
      seatA.queued = queuedA;
      seatB.queued = queuedB;
      if (a.readyState === WebSocket.OPEN) await this.enqueue(a, seatA, false);
      if (b.readyState === WebSocket.OPEN) await this.enqueue(b, seatB, false);
    };
    const fail = (code: string) => {
      this.send(a, { type: "error", code });
      this.send(b, { type: "error", code });
    };
    const category = await getCategory(this.env.DB, seatA.category);
    let candidates: Candidate[] = [];
    if (category !== null) {
      try {
        // A match never plays a personal chart: 'mine' is refused at the
        // routes, so the catalog is resolved without a user.
        candidates = await catalog(this.env, category, null);
      } catch {
        candidates = [];
      }
    }
    const room = category !== null && candidates.length >= 4;
    if (!room) {
      fail("feed");
      return;
    }
    if (a.readyState !== WebSocket.OPEN || b.readyState !== WebSocket.OPEN) {
      await rescue();
      return;
    }
    const code = newRoomCode();
    const players = [seatA, seatB].map((seat) => ({
      name: seat.name,
      token: newRoomSecret(),
      userId: seat.uid,
    }));
    const init = await this.env.ROOMS.get(
      this.env.ROOMS.idFromName(code),
    ).fetch(
      new Request("https://room/init", {
        method: "POST",
        body: JSON.stringify({
          code,
          kind: "match",
          categorySlug: category!.slug,
          categoryName: category!.name,
          mode: "choices",
          candidates,
          creatorToken: "",
          players,
        }),
      }),
    );
    if (!init.ok) {
      fail("feed");
      return;
    }
    // The init fetch is a second window for a socket to die; sending
    // 'matched' to a dead one strands the survivor in an empty room.
    if (a.readyState !== WebSocket.OPEN || b.readyState !== WebSocket.OPEN) {
      await rescue();
      return;
    }
    this.send(a, { type: "matched", code, token: players[0].token });
    this.send(b, { type: "matched", code, token: players[1].token });
  }
}
