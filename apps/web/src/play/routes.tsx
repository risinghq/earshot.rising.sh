import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { notFoundPage } from "../app";
import { sessionUser } from "../auth";
import type { Env } from "../types";
import type { Candidate } from "./sources";
import {
  catalog,
  enoughTracks,
  getCategory,
  listCategories,
  type Category,
} from "./catalog";
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
  artistPage,
  artistsPage,
  categoriesPage,
  feedErrorPage,
  gamePage,
  boardPage,
  matchPage,
} from "./pages";
import {
  readBoard,
  readCategoryBoard,
  recordGame,
  type CategoryBoardEntry,
} from "./results";
import { deezerSearchArtists } from "./sources";
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
  const user = await sessionUser(context);
  const category = await getCategory(context.env, slug);
  if (category === null) return context.html(notFoundPage(user), 404);
  if (!context.env.CACHE)
    return context.html(feedErrorPage(category.name, user), 503);
  if (category.feed === "mine" && user === null)
    return context.redirect("/", 303);
  let tracks;
  try {
    tracks = await catalog(context.env, category, user?.id ?? null);
  } catch (error) {
    console.error("play catalog failed", error);
    return context.html(feedErrorPage(category.name, user), 502);
  }
  if (!enoughTracks(category, tracks))
    return context.html(feedErrorPage(category.name, user), 502);
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
  if (!init.ok)
    return context.html(
      feedErrorPage(input.category.name, await sessionUser(context)),
      502,
    );
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
  const category = slug === "" ? null : await getCategory(context.env, slug);
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
  const category = await getCategory(context.env, slug);
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
  const category = await getCategory(context.env, context.req.param("slug"));
  const user = await sessionUser(context);
  if (category === null || category.feed === "mine")
    return context.html(notFoundPage(user), 404);
  return context.html(matchPage(category, user));
});

playApp.get("/board", async (context) => {
  const period = context.req.query("period") === "all" ? "all" : "week";
  const entries = await readBoard(context.env, period);
  return context.html(boardPage(entries, period, await sessionUser(context)));
});

playApp.get("/room/:code", async (context) => {
  const code = context.req.param("code");
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const exists = await room.fetch(new Request("https://room/exists"));
  if (!exists.ok) return context.html(notFoundPage(user), 404);
  return context.html(roomPage(code, user));
});

// The pick for a blend travels in the query: `with` holds the first artist's
// id and `n` its name, so choosing the second needs no stored state.
playApp.get("/artists", async (context) => {
  const user = await sessionUser(context);
  const query = context.req.query("q")?.trim() ?? "";
  const withParam = context.req.query("with") ?? "";
  const withName = context.req.query("n")?.trim() ?? "";
  const picked = /^\d{1,10}$/.test(withParam)
    ? { id: Number(withParam), name: withName || `Artist ${withParam}` }
    : null;
  if (query === "") return context.html(artistsPage(query, [], picked, user));
  let results;
  try {
    results = await deezerSearchArtists(query);
  } catch (error) {
    console.error("artist search failed", error);
    return context.html(feedErrorPage("Artist search", user), 502);
  }
  return context.html(artistsPage(query, results, picked, user));
});

playApp.get("/artist/:ids", async (context) => {
  const user = await sessionUser(context);
  const category = await getCategory(
    context.env,
    `artist-${context.req.param("ids")}`,
  );
  if (category === null) return context.html(notFoundPage(user), 404);
  const entries = await readCategoryBoard(context.env, category.slug);
  return context.html(artistPage(category, entries, user));
});

playApp.get("/", async (context) => {
  const user = await sessionUser(context);
  const categories = await listCategories(context.env.DB);
  const boards = Object.fromEntries(
    await Promise.all(
      categories.map(
        async (category): Promise<[string, CategoryBoardEntry[]]> => [
          category.slug,
          await readCategoryBoard(context.env, category.slug),
        ],
      ),
    ),
  );
  return context.html(categoriesPage(categories, boards, user));
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
  const user = await sessionUser(context);
  if (game === null) return context.html(notFoundPage(user), 404);
  const now = Date.now();
  const { preview, quota } =
    game.phase === "question"
      ? await serveRound(context.env, game, now)
      : { preview: null, quota: false };
  // A round that exhausts its candidates ends the game here; recordGame is a
  // no-op once the flag is set, so a final-page reload never reaches D1.
  if (game.phase === "done") await recordGame(context.env, game);
  if (game.phase === "done" && game.served === 0)
    return context.html(feedErrorPage(game.categoryName, user), 502);
  if (game.phase !== "question")
    return context.html(
      gamePage(game, { kind: game.phase }, now, {
        user,
        board:
          game.phase === "done"
            ? await readCategoryBoard(context.env, game.categorySlug)
            : [],
      }),
    );
  if (quota)
    return context.html(gamePage(game, { kind: "busy" }, now, { user }), 503);
  if (preview === null)
    return context.html(gamePage(game, { kind: "error" }, now, { user }));
  return context.html(
    gamePage(
      game,
      { kind: "question", preview, choices: game.current!.choices },
      now,
      { user },
    ),
  );
});

playApp.post("/:id/answer", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
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
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  if (advance(game)) {
    await putGame(context.env, game);
    if (game.phase === "done") await recordGame(context.env, game);
  }
  return context.redirect(`/play/${game.id}`, 303);
});
