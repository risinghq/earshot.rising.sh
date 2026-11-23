// Reads what a browser sends over a room's or the matchmaker's socket. The
// schemas live on the server only, so the client bundles never carry
// valibot; `satisfies` holds each one to the message type in protocol.ts.
import * as v from "valibot";
import type { ClientMessage, MatchClientMessage } from "./protocol";
import { modes } from "./rules";

// Longer text is cut, not refused: a pasted answer still counts.
const text = (max: number) =>
  v.pipe(
    v.string(),
    v.transform((value) => value.slice(0, max)),
  );

const clientMessage = v.variant("type", [
  v.object({
    type: v.literal("join"),
    token: v.optional(v.string()),
    name: v.optional(v.string()),
  }),
  v.object({ type: v.literal("watch") }),
  v.object({ type: v.literal("start") }),
  v.object({ type: v.literal("loaded") }),
  v.object({ type: v.literal("answer"), answer: text(200) }),
  v.object({
    type: v.literal("suggest"),
    category: text(80),
    mode: v.picklist(modes),
  }),
  v.object({ type: v.literal("vote"), id: v.string() }),
]) satisfies v.GenericSchema<unknown, ClientMessage>;

const matchMessage = v.object({
  type: v.literal("join"),
  name: v.optional(v.string()),
}) satisfies v.GenericSchema<unknown, MatchClientMessage>;

function read<T>(
  schema: v.GenericSchema<unknown, T>,
  raw: string | ArrayBuffer,
) {
  if (typeof raw !== "string") return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(schema, json);
  return parsed.success ? parsed.output : null;
}

// Null for anything that is not one of the messages: the socket ignores it.
export const readClientMessage = (raw: string | ArrayBuffer) =>
  read(clientMessage, raw);

export const readMatchMessage = (raw: string | ArrayBuffer) =>
  read(matchMessage, raw);
