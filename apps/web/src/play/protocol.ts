// The messages a room's WebSocket carries, between the room's Durable Object
// (room.ts) and the browser pages (client/room, client/screen.js). Types only,
// and imports only rules.ts, so a client bundle can take it whole.
import type { Choice, Mode } from "./rules";

export type RoomKind = "room" | "match";
export type RoomPhase = "lobby" | "loading" | "playing" | "reveal" | "done";

// A category's best scores over the last categoryBoardDays days.
export interface CategoryBoardEntry {
  name: string;
  score: number;
  // Of the best game. Null for games written before migration 0018; absent
  // from a board cached before it.
  correct?: number | null;
  rounds?: number | null;
  finished_at?: number;
}

export interface Reveal {
  number: number;
  track: string;
  title: string;
  original: string | null;
  artist: string;
  cover: string | null;
  link: string | null;
  // When the room moves on to the next round, in server time.
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
export type PastRound = Omit<Reveal, "until" | "track" | "choices">;

export interface RoomPlayer {
  name: string;
  creator: boolean;
  user: boolean;
  score: number;
  connected: boolean;
  answered: boolean;
}

// A suggestion for the next game, as one player sees it.
export interface UpNext {
  id: string;
  slug: string;
  name: string;
  mode: Mode;
  by: string;
  votes: number;
  voted: boolean;
  mine: boolean;
}

// The whole room as one device sees it, sent on every change. A TV that
// watches gets watch and an empty you.
export interface RoomState {
  type: "state";
  code: string;
  kind: RoomKind;
  category: string;
  categorySlug: string;
  mode: Mode;
  phase: RoomPhase;
  // Server time, so a device can correct its clock.
  now: number;
  rounds: number;
  seats: number;
  you: {
    name: string;
    creator: boolean;
    user: boolean;
    marks: boolean[];
    streak: number;
    // This round's pick, so a reload keeps it locked in.
    answer: string | null;
  };
  players: RoomPlayer[];
  // While loading, playing or revealing.
  round?: number;
  startedAt?: number;
  endsAt?: number;
  choices?: Choice[];
  clip?: string;
  watch?: true;
  // A TV watches this room, so the clip plays there only.
  screen?: true;
  reveal?: Reveal;
  // Once the game is done.
  standings?: { name: string; score: number; correct: number }[];
  board?: CategoryBoardEntry[];
  history?: PastRound[];
  suggestions?: UpNext[];
}

// What a device that holds no seat may see.
export interface RoomPreview {
  type: "preview";
  code: string;
  category: string;
  categorySlug: string;
  mode: Mode;
  rounds: number;
  seats: number;
  players: string[];
}

export type JoinError = "gone" | "full" | "name" | "taken";

export type ServerMessage =
  | RoomState
  | RoomPreview
  | { type: "joined"; name: string; token: string; creator: boolean }
  | { type: "moved" }
  | { type: "error"; code: JoinError };

export type ClientMessage =
  | { type: "join"; token?: string; name?: string }
  | { type: "watch" }
  | { type: "start" }
  | { type: "loaded" }
  | { type: "answer"; answer: string }
  | { type: "suggest"; category: string; mode: Mode }
  | { type: "vote"; id: string };

// The close codes the room ends a socket with.
export const closeCodes = { gone: 1001, moved: 4001 } as const;
