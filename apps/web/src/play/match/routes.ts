import { Hono } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { notFoundPage } from "../../ui/not-found";
import { getCategory } from "../catalog/catalog";
import { anonKey, anonOf } from "../game/outcomes";
import { matchPage } from "./page";

export const matchApp = new Hono<{ Bindings: Env }>();

// The queue for a random match lives in one global Matchmaker object; the
// player waits on its socket until a peer in the same category appears.
matchApp.post("/match", async (context) => {
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

matchApp.get("/match/:slug/ws", async (context) => {
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

matchApp.get("/match/:slug", async (context) => {
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
