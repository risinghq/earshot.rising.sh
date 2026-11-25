import { Hono, type Context } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { notFoundPage } from "../../ui/not-found";
import { forYouSlug } from "../catalog/foryou";
import { serveClip } from "../game/clip";
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
} from "../game/game";
import { anonOf } from "../game/outcomes";
import { claimGame, readCategoryBoard, recordGame } from "../game/results";
import { feedErrorPage } from "../hub/page";
import { gameInput } from "../input";
import { gamePage } from "./page";

export const soloApp = new Hono<{ Bindings: Env }>();

type PlayContext = Context<{ Bindings: Env }>;

soloApp.post("/", async (context) => {
  const input = await gameInput(context, true);
  if (input instanceof Response) return input;
  const game = await buildGame(
    context.env,
    input.category,
    input.mode,
    input.tracks,
    input.userId,
    input.playerKey,
    input.clip ?? "preview",
  );
  return context.redirect(`/play/${game.id}`, 303);
});

// client/solo.ts sends this header and takes the page in the reply, saving the
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

const background = (context: PlayContext) => (work: Promise<unknown>) => {
  void after(context, work);
};

// The page of a game at its phase, serving the round when one is due. Game
// chrome carries no site header, so the question and reveal pages skip the
// session lookup; the pages that show the account still make it.
async function renderGame(context: PlayContext, game: Game) {
  const now = Date.now();
  const { preview, quota } =
    game.phase === "question"
      ? await serveRound(context.env, game, now, background(context))
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

// The intro clip a paid round plays: mp3 bytes warmed into KV by the fetch
// pipeline. The k signature proves the URL was served; a guessed deezer id
// gets nothing.
soloApp.get("/clip/:id", async (context) => {
  const id = Number(context.req.param("id"));
  const bytes = Number.isInteger(id)
    ? await serveClip(context.env, id, context.req.query("k"))
    : null;
  if (bytes === null) return context.text("not found", 404);
  // Safari fetches <audio> with Range requests; without 206 it never plays.
  const total = bytes.byteLength;
  const headers = {
    "content-type": "audio/mpeg",
    "cache-control": "private, max-age=3600",
    "accept-ranges": "bytes",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(context.req.header("range") ?? "");
  if (range) {
    const start = Number(range[1]);
    const end =
      range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
    if (start > end || start >= total)
      return context.text("range not satisfiable", 416, {
        "content-range": `bytes */${total}`,
      });
    return context.body(bytes.slice(start, end + 1), 206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": String(end - start + 1),
    });
  }
  return context.body(bytes, 200, headers);
});

soloApp.get("/:id", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null)
    return context.html(notFoundPage(await sessionUser(context)), 404);
  return renderGame(context, game);
});

// A second answer to the same round finds the game at its reveal and gets the
// reveal back unchanged, so a double tap cannot score twice.
soloApp.post("/:id/answer", async (context) => {
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
soloApp.post("/:id/playing", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.json({ error: "no such game" }, 404);
  const remaining = await reportPlaying(context.env, game, Date.now());
  if (remaining === null) return context.json({ error: "no open round" }, 409);
  return context.json({ remaining });
});

// While the reveal is up, the client asks for the next round's clip and
// preloads it, with the question page it will show, so Continue paints from
// memory while /next serves the same round.
soloApp.post("/:id/prepare", async (context) => {
  const game = await getGame(context.env, context.req.param("id"));
  if (game === null) return context.json({ error: "no such game" }, 404);
  const url = await prepareNext(context.env, game, background(context));
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

soloApp.post("/:id/next", async (context) => {
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
