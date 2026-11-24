// Runs the random-match queue: seats players, pairs two in one category and
// opens their room. The sockets, the clock, the track pool and the room
// come in through MatchPorts, so the Durable Object supplies the real ones
// and a test supplies fakes.
import type { MatchClientMessage, MatchServerMessage } from "../room/protocol";
import { nicknameMaxLength, type RoomInit } from "../room/game";
import type { Candidate } from "../catalog/sources";

// A queued player. The Matchmaker keeps it on the socket, so `queued` is the
// whole queue state: 0 not yet queued, `pairing` held by a pair in progress,
// otherwise the time the player joined the line.
export interface Seat {
  category: string;
  era: number | null;
  uid: number | null;
  anon: string | null;
  name: string;
  queued: number;
}

export const pairing = -1;

export interface MatchSocket {
  seat(): Seat | null;
  setSeat(seat: Seat): void;
  send(message: MatchServerMessage): void;
  isOpen(): boolean;
}

export interface Pool {
  slug: string;
  name: string;
  candidates: Candidate[];
}

export interface MatchPorts {
  now(): number;
  sockets(): MatchSocket[];
  // The tracks a match in this category and era plays, or null when there
  // are too few to fill one.
  pool(slug: string, era: number | null): Promise<Pool | null>;
  openRoom(init: RoomInit): Promise<boolean>;
  newCode(): string;
  newSecret(): string;
}

interface Waiter {
  socket: MatchSocket;
  seat: Seat;
}

export class MatchHost {
  constructor(private readonly ports: MatchPorts) {}

  // The queued players, oldest first.
  waiting(): Waiter[] {
    return this.ports
      .sockets()
      .map((socket) => ({ socket, seat: socket.seat() }))
      .filter(
        (entry): entry is Waiter =>
          entry.seat !== null && entry.seat.queued > 0,
      )
      .sort((a, b) => a.seat.queued - b.seat.queued);
  }

  async join(socket: MatchSocket, message: MatchClientMessage) {
    const seat = socket.seat();
    if (seat === null || seat.queued !== 0) return;
    if (seat.uid === null) {
      const name = message.name?.trim() ?? "";
      if (name === "" || [...name].length > nicknameMaxLength) {
        socket.send({ type: "error", code: "name" });
        return;
      }
      seat.name = name;
    }
    await this.enqueue({ socket, seat }, true);
  }

  // Queues the seat behind the other same-category waiters, or pairs it with
  // the oldest one. A seat coming back from a dead pair keeps its place in
  // line and is never refused for a name it already waited with.
  private async enqueue(me: Waiter, refuseTaken: boolean) {
    const { seat } = me;
    const same = this.waiting().filter(
      (entry) =>
        entry.seat.category === seat.category && entry.seat.era === seat.era,
    );
    const partner = same.find(
      (entry) => entry.seat.name.toLowerCase() !== seat.name.toLowerCase(),
    );
    if (partner !== undefined) return this.pair(partner, me);
    if (refuseTaken && same.length > 0) {
      me.socket.send({ type: "error", code: "taken" });
      return;
    }
    if (seat.queued <= 0) seat.queued = this.ports.now();
    me.socket.setSeat(seat);
    me.socket.send({ type: "queued" });
  }

  private async pair(a: Waiter, b: Waiter) {
    const places = [a.seat.queued, b.seat.queued];
    for (const w of [a, b]) {
      w.seat.queued = pairing;
      w.socket.setSeat(w.seat);
    }
    // Either socket may close during the awaits below. A seat left marked
    // `pairing` never re-queues itself, so the survivor goes back through
    // enqueue, in its old place, and can match the next waiter.
    const bothOpen = () => a.socket.isOpen() && b.socket.isOpen();
    const rescue = async () => {
      a.seat.queued = places[0];
      b.seat.queued = places[1];
      for (const w of [a, b])
        if (w.socket.isOpen()) await this.enqueue(w, false);
    };
    const fail = () => {
      a.socket.send({ type: "error", code: "feed" });
      b.socket.send({ type: "error", code: "feed" });
    };
    const pool = await this.ports.pool(a.seat.category, a.seat.era);
    if (pool === null) return fail();
    if (!bothOpen()) return rescue();
    const code = this.ports.newCode();
    const players = [a.seat, b.seat].map((seat) => ({
      name: seat.name,
      token: this.ports.newSecret(),
      userId: seat.uid,
      anon: seat.anon,
    }));
    const opened = await this.ports.openRoom({
      code,
      kind: "match",
      categorySlug: pool.slug,
      categoryName: pool.name,
      mode: "normal",
      candidates: pool.candidates,
      creatorToken: "",
      players,
    });
    if (!opened) return fail();
    // Opening the room is a second window for a socket to close; sending
    // 'matched' to a closed one strands the survivor in an empty room.
    if (!bothOpen()) return rescue();
    a.socket.send({ type: "matched", code, token: players[0].token });
    b.socket.send({ type: "matched", code, token: players[1].token });
  }
}
