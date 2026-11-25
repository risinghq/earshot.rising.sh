import { Hono, type Context } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { database } from "../../platform/db";
import { forYouCold } from "../catalog/foryou";
import { introSeconds, parseClipKind } from "../game/clip";
import { anonOf, playerKeyOf } from "../game/outcomes";
import { defaultMode, parseMode } from "../game/quiz";
import { isRoomCode } from "../room/room";
import { hubTiles } from "./hub";
import { hubPage } from "./page";

export const hubApp = new Hono<{ Bindings: Env }>();

// The play hub is the home page, at GET /.
export async function renderHub(context: Context<{ Bindings: Env }>) {
  const [user, { categories, facts }] = await Promise.all([
    sessionUser(context),
    hubTiles(context.env),
  ]);
  const playerKey = playerKeyOf(user?.id ?? null, anonOf(context));
  const cold = await forYouCold(
    database(context.env.DB),
    playerKey,
    user?.id ?? null,
  );
  const who = context.req.query("who");
  const mode = context.req.query("mode");
  const room = context.req.query("room")?.toUpperCase();
  return context.html(
    hubPage({
      categories,
      facts,
      user,
      who: who === "room" ? "room" : "solo",
      mode: parseMode(mode) ?? defaultMode,
      clip:
        user?.tier === "paid"
          ? (parseClipKind(context.req.query("clip")) ?? "preview")
          : "preview",
      introSeconds: introSeconds(context.env),
      forYouColdStart: cold,
      room: room !== undefined && isRoomCode(room) ? room : undefined,
    }),
  );
}

// The hub moved to /; old links keep their who and mode choices.
hubApp.get("/", (context) => {
  const query = new URL(context.req.url).search;
  return context.redirect(`/${query}`, 301);
});
