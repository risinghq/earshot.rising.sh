import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { notFoundPage } from "../app";
import { sessionUser } from "../auth";
import type { Env } from "../types";
import type { Candidate } from "./sources";
import { defaultMode, parseMode } from "./quiz";
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
  prepareNext,
  previewNext,
  putGame,
  reportPlaying,
  serveRound,
  type Game,
  type Mode,
} from "./game";
import {
  artistPage,
  artistsPage,
  feedErrorPage,
  gamePage,
  boardPage,
  categoryBoardPage,
  hubPage,
  matchPage,
} from "./pages";
import { tileFacts } from "./hub";
import { claimGame, readBoard, readCategoryBoard, recordGame } from "./results";
import { forYouCategory, forYouCold, forYouMix, forYouSlug } from "./foryou";
import { deezerSearchArtists } from "./sources";
import { byDecade } from "./pool";
import { anonKey, anonOf, playerKeyOf } from "./outcomes";
import { isRoomCode, newRoomCode, newRoomSecret } from "./room";
import { roomPage } from "./room-page";
import { screenPage } from "./screen-page";

export const playApp = new Hono<{ Bindings: Env }>();

playApp.use("*", csrf());

// One entry check for both game kinds: same form fields, same category and
// mode validation, same catalogue fetch, same minimum track count.
async function gameInput(
  context: Context<{ Bindings: Env }>,
  forYou = false,
): Promise<
  | {
      category: Category;
      mode: Mode;
      tracks: Candidate[];
      userId: number | null;
      playerKey: string;
    }
  | Response
> {
  const body = await context.req.parseBody();
  const slug = typeof body.category === "string" ? body.category : "";
  const mode = parseMode(body.mode);
  const era = /^\d{3,4}$/.test(String(body.era)) ? Number(body.era) : null;
  if (slug === "" || mode === null)
    return context.text("Pick a category and a mode.", 400);
  const user = await sessionUser(context);
  // A room's switch keeps its host in the room's category picker.
  const room = context.req.param("code");
  const back = room ? `/?room=${room}&mode=${mode}` : "/";
  // For you is a solo-only game: its pool is one player's mix, so a room or a
  // match would sit everyone in the creator's taste.
  if (slug === forYouSlug) {
    if (!forYou) return context.html(notFoundPage(user), 404);
    if (!context.env.CACHE)
      return context.html(feedErrorPage(forYouCategory.name, user), 503);
    const anon = anonKey(context);
    const playerKey = playerKeyOf(user?.id ?? null, anon);
    const tracks = await forYouMix(context.env, playerKey, user?.id ?? null);
    if (!enoughTracks(forYouCategory, tracks))
      return context.html(feedErrorPage(forYouCategory.name, user), 502);
    return {
      category: forYouCategory,
      mode,
      tracks,
      userId: user?.id ?? null,
      playerKey,
    };
  }
  const category = await getCategory(context.env, slug);
  if (category === null) return context.html(notFoundPage(user), 404);
  if (!context.env.CACHE)
    return context.html(feedErrorPage(category.name, user, back), 503);
  if (category.feed === "mine" && user === null)
    return context.redirect("/", 303);
  let tracks;
  try {
    tracks = await catalog(context.env, category, user?.id ?? null);
  } catch (error) {
    console.error("play catalog failed", error);
    return context.html(feedErrorPage(category.name, user, back), 502);
  }
  if (era !== null) tracks = byDecade(tracks, era);
  if (!enoughTracks(category, tracks))
    return context.html(feedErrorPage(category.name, user, back), 502);
  const anon = anonKey(context);
  return {
    category:
      era === null
        ? category
        : { ...category, name: `${category.name} · ${era}s` },
    mode,
    tracks,
    userId: user?.id ?? null,
    playerKey: playerKeyOf(user?.id ?? null, anon),
  };
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

// The hub, opened from a finished room, posts the next category here. The
// creator's token proves who asks; everyone stays seated.
playApp.post("/room/:code/switch", async (context) => {
  const code = context.req.param("code");
  if (!isRoomCode(code))
    return context.html(notFoundPage(await sessionUser(context)), 404);
  const input = await gameInput(context);
  if (input instanceof Response) return input;
  const body = await context.req.parseBody();
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const reply = await room.fetch(
    new Request("https://room/retarget", {
      method: "POST",
      body: JSON.stringify({
        token: typeof body.k === "string" ? body.k : "",
        categorySlug: input.category.slug,
        categoryName: input.category.name,
        mode: input.mode,
        candidates: input.tracks,
      }),
    }),
  );
  if (reply.status === 404)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  if (reply.status === 403)
    return context.text("Only the room's creator picks the category.", 403);
  // 409: a game is running; the room page shows it.
  return context.redirect(`/play/room/${code}`, 303);
});

playApp.get("/room/:code/ws", async (context) => {
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
  const era = /^\d{3,4}$/.test(String(body.era)) ? `?era=${body.era}` : "";
  anonKey(context);
  return context.redirect(`/play/match/${category.slug}${era}`, 303);
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
  const era = context.req.query("era");
  if (era !== undefined && /^\d{3,4}$/.test(era)) params.set("e", era);
  if (user !== null) {
    params.set("u", String(user.id));
    params.set("n", user.name);
  } else {
    const anon = anonOf(context);
    if (anon !== null) params.set("a", anon);
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
  if (user === null) anonKey(context);
  const era = context.req.query("era");
  return context.html(
    matchPage(
      category,
      user,
      era !== undefined && /^\d{3,4}$/.test(era) ? Number(era) : null,
    ),
  );
});

playApp.get("/board", async (context) => {
  const user = await sessionUser(context);
  const slug = context.req.query("category");
  const categories = await listCategories(context.env.DB);
  if (slug !== undefined) {
    const category = await getCategory(context.env, slug);
    if (category !== null) {
      const entries = await readCategoryBoard(context.env, slug);
      return context.html(
        categoryBoardPage(category, entries, user, categories),
      );
    }
  }
  const period = context.req.query("period") === "all" ? "all" : "week";
  const entries = await readBoard(context.env, period);
  return context.html(boardPage(entries, period, user, categories));
});

// The screen view is the room on a shared display: it watches the game and
// plays the clip while the players answer on their phones.
playApp.get("/room/:code/screen", async (context) => {
  const code = context.req.param("code");
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const exists = await room.fetch(new Request("https://room/exists"));
  if (!exists.ok) return context.html(notFoundPage(user), 404);
  const joinUrl = `${new URL(context.req.url).origin}/play/room/${code}`;
  return context.html(screenPage(code, joinUrl));
});

playApp.get("/room/:code", async (context) => {
  const code = context.req.param("code");
  const user = await sessionUser(context);
  const room = context.env.ROOMS.get(context.env.ROOMS.idFromName(code));
  const exists = await room.fetch(new Request("https://room/exists"));
  if (!exists.ok) return context.html(notFoundPage(user), 404);
  if (user === null) anonKey(context);
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
  if (category.slug !== `artist-${context.req.param("ids")}`)
    return context.redirect(`/play/artist/${category.slug.slice(7)}`, 301);
  const entries = await readCategoryBoard(context.env, category.slug);
  return context.html(artistPage(category, entries, user));
});

const reportReasons = new Set([
  "wrong_song",
  "bad_clip",
  "wrong_title",
  "other",
]);
const reportLimitPerHour = 10;

// A report needs the player key only to rate-limit it; signed-out players
// report too, so the key may be the anonymous cookie.
playApp.post("/report", async (context) => {
  const body = await context.req.parseBody();
  const reason = typeof body.reason === "string" ? body.reason : "";
  const track = typeof body.track === "string" ? body.track : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const artist = typeof body.artist === "string" ? body.artist.trim() : "";
  const back = typeof body.back === "string" ? body.back : "/";
  if (!reportReasons.has(reason) || track === "" || title === "")
    return context.text("Bad report.", 400);
  const user = await sessionUser(context);
  // Reads the existing cookie without minting: a cookieless client lands in
  // the shared `a:` bucket so the hourly limit still applies.
  const playerKey = playerKeyOf(user?.id ?? null, anonOf(context));
  const now = Math.floor(Date.now() / 1000);
  const recent = await context.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM track_reports
     WHERE player_key = ?1 AND created_at > ?2`,
  )
    .bind(playerKey, now - 3600)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= reportLimitPerHour)
    return context.text("Too many reports. Try again later.", 429);
  const category = typeof body.category === "string" ? body.category : "";
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  await context.env.DB.prepare(
    `INSERT INTO track_reports
       (track_key, title, artist, category, reason, detail,
        player_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      track,
      title,
      artist,
      category || null,
      reason,
      detail || null,
      playerKey,
      now,
    )
    .run();
  return context.redirect(
    back.startsWith("/") && !back.startsWith("//") ? back : "/",
    303,
  );
});

// The play hub is the home page, at GET /.
export async function renderHub(context: PlayContext) {
  const user = await sessionUser(context);
  const categories = await listCategories(context.env.DB);
  const playerKey = playerKeyOf(user?.id ?? null, anonOf(context));
  const [facts, cold] = await Promise.all([
    tileFacts(context.env, categories),
    forYouCold(context.env.DB, playerKey, user?.id ?? null),
  ]);
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
      forYouColdStart: cold,
      room: room !== undefined && isRoomCode(room) ? room : undefined,
    }),
  );
}

// The hub moved to /; old links keep their who and mode choices.
playApp.get("/", (context) => {
  const query = new URL(context.req.url).search;
  return context.redirect(`/${query}`, 301);
});

playApp.post("/", async (context) => {
  const input = await gameInput(context, true);
  if (input instanceof Response) return input;
  const game = await buildGame(
    context.env,
    input.category,
    input.mode,
    input.tracks,
    input.userId,
    input.playerKey,
  );
  return context.redirect(`/play/${game.id}`, 303);
});

type PlayContext = Context<{ Bindings: Env }>;

// solo.js sends this header and takes the page in the reply, saving the
// redirect's second round trip. A form post without the script keeps the 303,
// so a reload of the page cannot resubmit the form.
const inline = (context: PlayContext) => context.req.header("x-solo") === "1";

// Work the reply need not wait for runs after it. A test that calls app.fetch
// without an execution context has nowhere to hand it, so it waits instead.
async function after(context: PlayContext, work: Promise<unknown>) {
  let waitUntil: ((work: Promise<unknown>) => void) | undefined;
  try {
    const ctx = context.executionCtx;
    waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    waitUntil = undefined;
  }
  if (waitUntil) waitUntil(work);
  else await work;
}

// The page of a game at its phase, serving the round when one is due. Game
// chrome carries no site header, so the question and reveal pages skip the
// session lookup; the pages that show the account still make it.
async function renderGame(context: PlayContext, game: Game) {
  const now = Date.now();
  const { preview, quota } =
    game.phase === "question"
      ? await serveRound(context.env, game, now)
      : { preview: null, quota: false };
  if (game.phase === "reveal")
    return context.html(gamePage(game, { kind: "reveal" }, now));
  if (game.phase === "question" && preview !== null)
    return context.html(
      gamePage(
        game,
        { kind: "question", preview, choices: game.current!.choices },
        now,
      ),
    );
  const user = await sessionUser(context);
  if (user !== null && claimGame(game, user.id, anonOf(context)))
    await putGame(context.env, game);
  // A round that exhausts its candidates ends the game here; recordGame is a
  // no-op once the flag is set, so a final-page reload never reaches D1.
  if (game.phase === "done") await recordGame(context.env, game);
  if (game.phase === "done" && game.served === 0)
    return context.html(feedErrorPage(game.categoryName, user), 502);
  if (game.phase === "done")
    return context.html(
      gamePage(game, { kind: "done" }, now, {
        user,
        board:
          game.categorySlug !== forYouSlug
            ? await readCategoryBoard(context.env, game.categorySlug)
            : [],
      }),
    );
  if (quota)
    return context.html(gamePage(game, { kind: "busy" }, now, { user }), 503);
  return context.html(gamePage(game, { kind: "error" }, now, { user }));
}

playApp.get("/:id", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  return renderGame(context, game);
});

// A second answer to the same round finds the game at its reveal and gets the
// reveal back unchanged, so a double tap cannot score twice.
playApp.post("/:id/answer", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  const body = await context.req.parseBody();
  const answered = await answerRound(
    context.env,
    game,
    {
      choice: typeof body.choice === "string" ? body.choice : undefined,
      typed: typeof body.answer === "string" ? body.answer : undefined,
    },
    Date.now(),
  );
  if (answered !== null) await after(context, answered.outcome);
  if (inline(context)) return renderGame(context, game);
  return context.redirect(`/play/${game.id}`, 303);
});

// The page reports the clip actually playing; the clock starts at that
// report, capped inside reportPlaying. A report with no open round (before a
// serve or after the answer) is refused, so only the open round's own client
// can start its clock.
playApp.post("/:id/playing", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.json({ error: "no such game" }, 404);
  const remaining = await reportPlaying(context.env, game, Date.now());
  if (remaining === null) return context.json({ error: "no open round" }, 409);
  return context.json({ remaining });
});

// While the reveal is up, the client asks for the next round's clip and
// preloads it, with the question page it will show, so Continue paints from
// memory while /next serves the same round.
playApp.post("/:id/prepare", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.json({ error: "no such game" }, 404);
  const url = await prepareNext(context.env, game);
  if (url === null) return context.json({ url: null, html: null });
  const fresh = await getGame(context.env, game.id);
  const next = fresh && previewNext(fresh, Date.now());
  const html =
    next === null
      ? null
      : (
          await gamePage(
            next.game,
            {
              kind: "question",
              preview: next.preview,
              choices: next.game.current!.choices,
            },
            Date.now(),
          )
        ).toString();
  return context.json({ url, html });
});

playApp.post("/:id/next", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  if (advance(game)) {
    await putGame(context.env, game);
    if (game.phase === "done") await recordGame(context.env, game);
  }
  if (inline(context)) return renderGame(context, game);
  return context.redirect(`/play/${game.id}`, 303);
});
