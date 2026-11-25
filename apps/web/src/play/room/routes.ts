import { Hono } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { database } from "../../platform/db";
import { notFoundPage } from "../../ui/not-found";
import { listCategories } from "../catalog/catalog";
import { deezerSearchArtists } from "../catalog/sources";
import { anonKey, anonOf } from "../game/outcomes";
import { feedErrorPage } from "../hub/page";
import { gameInput } from "../input";
import { roomPage } from "./page";
import { qrPath } from "./qr";
import { isRoomCode, newRoomCode, newRoomSecret } from "./room";
import { screenPage } from "./screen-page";

export const roomApp = new Hono<{ Bindings: Env }>();

roomApp.post("/room", async (context) => {
  const input = await gameInput(context);
  if (input instanceof Response) return input;
  const code = newRoomCode();
  const creatorToken = newRoomSecret();
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const created = await room.init({
    code,
    kind: "room",
    categorySlug: input.category.slug,
    categoryName: input.category.name,
    mode: input.mode,
    clip: input.clip ?? "preview",
    candidates: input.tracks,
    creatorToken,
    players: [],
  });
  if (!created)
    return context.html(
      feedErrorPage(input.category.name, await sessionUser(context)),
      502,
    );
  return context.redirect(`/play/room/${code}?k=${creatorToken}`, 303);
});

// The hub, opened from a finished room, posts the next category here. The
// creator's token proves who asks; everyone stays seated.
roomApp.post("/room/:code/switch", async (context) => {
  const code = context.req.param("code");
  if (!isRoomCode(code))
    return context.html(notFoundPage(await sessionUser(context)), 404);
  const input = await gameInput(context);
  if (input instanceof Response) return input;
  const body = await context.req.parseBody();
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const status = await room.retarget(
    typeof body.k === "string" ? body.k : "",
    {
      categorySlug: input.category.slug,
      categoryName: input.category.name,
      mode: input.mode,
      clip: input.clip,
      candidates: input.tracks,
    },
    body.start === "1",
  );
  if (status === 404)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  if (status === 403)
    return context.text("Only the room's creator picks the category.", 403);
  // 409: a game is running; the room page shows it.
  return context.redirect(`/play/room/${code}`, 303);
});

roomApp.get("/room/:code/ws", async (context) => {
  if (context.req.header("upgrade") !== "websocket")
    return context.text("expected a WebSocket", 426);
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(
    context.env.ROOMS.idFromName(context.req.param("code")),
  );
  const params = new URLSearchParams();
  if (user !== null) {
    params.set("u", String(user.id));
    params.set("n", user.name);
  } else {
    const anon = anonOf(context);
    if (anon !== null) params.set("a", anon);
  }
  const target = `https://room/ws${params.size ? `?${params}` : ""}`;
  return room.fetch(new Request(target, context.req.raw));
});

// The screen view is the room on a shared display: it watches the game and
// plays the clip while the players answer on their phones.
roomApp.get("/room/:code/screen", async (context) => {
  const code = context.req.param("code");
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  if (!(await room.exists())) return context.html(notFoundPage(user), 404);
  const joinUrl = `${new URL(context.req.url).origin}/play/room/${code}`;
  return context.html(screenPage(code, joinUrl));
});

// The QR code of a seat's own link, which moves the seat to the device that
// opens it. Only the seat's device holds the key, so the server just draws
// the link it is given; the Devices sheet shows it.
roomApp.get("/room/:code/seat.svg", (context) => {
  const code = context.req.param("code");
  const key = context.req.query("k") ?? "";
  if (!isRoomCode(code) || !/^[\w-]{8,64}$/.test(key))
    return context.text("not found", 404);
  const { viewBox, d } = qrPath(
    `${new URL(context.req.url).origin}/play/room/${code}?k=${key}`,
  );
  return context.body(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="${d}"/></svg>`,
    200,
    {
      "content-type": "image/svg+xml",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
    },
  );
});

roomApp.get("/room/:code", async (context) => {
  const code = context.req.param("code");
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  if (!(await room.exists())) return context.html(notFoundPage(user), 404);
  if (user === null) anonKey(context);
  return context.html(roomPage(code, user));
});

// The room's Up next sheet reads its choices here: the genres without a
// query, the top artists for one. A personal mix is left out, because a room
// cannot play it.
roomApp.get("/picks", async (context) => {
  const query = context.req.query("q")?.trim().slice(0, 80) ?? "";
  if (query === "") {
    const genres = (await listCategories(database(context.env.DB)))
      .filter((category) => category.feed !== "mine")
      .map(({ slug, name }) => ({ slug, name }));
    return context.json({ genres });
  }
  try {
    const artists = (await deezerSearchArtists(query))
      .slice(0, 6)
      .map((hit) => ({
        slug: `artist-${hit.id}`,
        name: hit.name,
        fans: hit.fans,
        picture: hit.picture,
      }));
    return context.json({ artists });
  } catch (error) {
    console.error("artist search failed", error);
    return context.json({ error: "search" }, 502);
  }
});
