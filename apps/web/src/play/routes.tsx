import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { notFoundPage } from "../app";
import { sessionUser } from "../auth";
import type { Env } from "../types";
import type { Candidate } from "./sources";
import { catalog, getCategory, listCategories, type Category } from "./catalog";
import {
  advance,
  answerRound,
  buildGame,
  getGame,
  putGame,
  serveRound,
  type Mode,
} from "./game";
import {
  categoriesPage,
  feedErrorPage,
  gamePage,
  boardPage,
  matchPage,
} from "./pages";
import { readBoard, recordGame } from "./results";
import { newRoomCode, newRoomSecret } from "./room";
import { roomPage } from "./room-page";

export const playApp = new Hono<{ Bindings: Env }>();

playApp.use("*", csrf());

// One entry check for both game kinds: same form fields, same category and
// mode validation, same catalogue fetch, same minimum track count.
async function gameInput(context: Context<{ Bindings: Env }>): Promise<
  | {
      category: Category;
      mode: Mode;
      tracks: Candidate[];
      userId: number | null;
    }
  | Response
> {
  const body = await context.req.parseBody();
  const slug = typeof body.category === "string" ? body.category : "";
  const mode: Mode | null =
    body.mode === "choices" || body.mode === "typed" ? body.mode : null;
  if (slug === "" || mode === null)
    return context.text("Pick a category and a mode.", 400);
  const category = await getCategory(context.env.DB, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  if (!context.env.CACHE)
    return context.html(feedErrorPage(category.name), 503);
  const user = await sessionUser(context);
  if (category.feed === "mine" && user === null)
    return context.redirect("/", 303);
  let tracks;
  try {
    tracks = await catalog(context.env, category, user?.id ?? null);
  } catch (error) {
    console.error("play catalog failed", error);
    return context.html(feedErrorPage(category.name), 502);
  }
  if (tracks.length < 4) return context.html(feedErrorPage(category.name), 502);
  return { category, mode, tracks, userId: user?.id ?? null };
}

playApp.post("/room", async (context) => {
  const input = await gameInput(context);
  if (input instanceof Response) return input;
  const code = newRoomCode();
  const creatorToken = newRoomSecret();
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const init = await room.fetch(
    new Request("https://room/init", {
      method: "POST",
      body: JSON.stringify({
        code,
        categorySlug: input.category.slug,
        categoryName: input.category.name,
        mode: input.mode,
        candidates: input.tracks,
        creatorToken,
      }),
    }),
  );
  if (!init.ok) return context.html(feedErrorPage(input.category.name), 502);
  return context.redirect(`/play/room/${code}?k=${creatorToken}`, 303);
});

playApp.get("/room/:code/ws", async (context) => {
  if (context.req.header("upgrade") !== "websocket")
    return context.text("expected a WebSocket", 426);
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(
    context.env.ROOMS.idFromName(context.req.param("code")),
  );
  const target =
    user === null ? "https://room/ws" : `https://room/ws?u=${user.id}`;
  return room.fetch(new Request(target, context.req.raw));
});

// The queue for a random match lives in one global Matchmaker object; the
// player waits on its socket until a peer in the same category appears.
playApp.post("/match", async (context) => {
  const body = await context.req.parseBody();
  const slug = typeof body.category === "string" ? body.category : "";
  const category = slug === "" ? null : await getCategory(context.env.DB, slug);
  if (category === null) return context.text("Pick a category.", 400);
  // A stranger must never play someone's listening history.
  if (category.feed === "mine")
    return context.text("No random matches in this category.", 400);
  return context.redirect(`/play/match/${category.slug}`, 303);
});

playApp.get("/match/:slug/ws", async (context) => {
  if (context.req.header("upgrade") !== "websocket")
    return context.text("expected a WebSocket", 426);
  const slug = context.req.param("slug");
  const category = await getCategory(context.env.DB, slug);
  if (category === null || category.feed === "mine")
    return context.text("no such category", 404);
  const user = await sessionUser(context);
  const params = new URLSearchParams({ category: category.slug });
  if (user !== null) {
    params.set("u", String(user.id));
    params.set("n", user.name);
  }
  const matchmaker = context.env.MATCHMAKER.get(
    context.env.MATCHMAKER.idFromName("global"),
  );
  return matchmaker.fetch(
    new Request(`https://match/ws?${params}`, context.req.raw),
  );
});

playApp.get("/match/:slug", async (context) => {
  const category = await getCategory(context.env.DB, context.req.param("slug"));
  if (category === null || category.feed === "mine")
    return context.html(notFoundPage(), 404);
  const user = await sessionUser(context);
  return context.html(matchPage(category, user !== null));
});

playApp.get("/board", async (context) => {
  const period = context.req.query("period") === "all" ? "all" : "week";
  const entries = await readBoard(context.env, period);
  return context.html(boardPage(entries, period));
});

playApp.get("/room/:code", async (context) => {
  const code = context.req.param("code");
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const exists = await room.fetch(new Request("https://room/exists"));
  if (!exists.ok) return context.html(notFoundPage(), 404);
  return context.html(roomPage(code));
});

playApp.get("/", async (context) => {
  const user = await sessionUser(context);
  const categories = await listCategories(context.env.DB);
  return context.html(categoriesPage(categories, user !== null));
});

playApp.post("/", async (context) => {
  const input = await gameInput(context);
  if (input instanceof Response) return input;
  const game = await buildGame(
    context.env,
    input.category,
    input.mode,
    input.tracks,
    input.userId,
  );
  return context.redirect(`/play/${game.id}`, 303);
});

playApp.get("/:id", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  const now = Date.now();
  const { preview, quota } =
    game.phase === "question"
      ? await serveRound(context.env, game, now)
      : { preview: null, quota: false };
  // A round that exhausts its candidates ends the game here; recordGame is a
  // no-op once the flag is set, so a final-page reload never reaches D1.
  if (game.phase === "done") await recordGame(context.env, game);
  if (game.phase === "done" && game.served === 0)
    return context.html(feedErrorPage(game.categoryName), 502);
  if (game.phase !== "question")
    return context.html(
      gamePage(game, { kind: game.phase }, now, {
        signedIn: (await sessionUser(context)) !== null,
      }),
    );
  if (quota) return context.html(gamePage(game, { kind: "busy" }, now), 503);
  if (preview === null)
    return context.html(gamePage(game, { kind: "error" }, now));
  return context.html(
    gamePage(
      game,
      { kind: "question", preview, choices: game.current!.choices },
      now,
    ),
  );
});

playApp.post("/:id/answer", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  const body = await context.req.parseBody();
  await answerRound(
    context.env,
    game,
    {
      choice: typeof body.choice === "string" ? body.choice : undefined,
      typed: typeof body.answer === "string" ? body.answer : undefined,
    },
    Date.now(),
  );
  return context.redirect(`/play/${game.id}`, 303);
});

playApp.post("/:id/next", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.html(notFoundPage(), 404);
  if (advance(game)) {
    await putGame(context.env, game);
    if (game.phase === "done") await recordGame(context.env, game);
  }
  return context.redirect(`/play/${game.id}`, 303);
});
