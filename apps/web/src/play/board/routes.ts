import { Hono } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { database } from "../../platform/db";
import { getCategory, listCategories } from "../catalog/catalog";
import { readBoard, readCategoryBoard } from "../game/results";
import { boardPage, categoryBoardPage } from "./page";

export const boardApp = new Hono<{ Bindings: Env }>();

boardApp.get("/board", async (context) => {
  const slug = context.req.query("category");
  const period = context.req.query("period") === "all" ? "all" : "week";
  // Independent reads run together. A category's board waits for the
  // category, because reading it caches the board under the slug.
  const [user, categories, category, points] = await Promise.all([
    sessionUser(context),
    listCategories(database(context.env.DB)),
    slug === undefined ? null : getCategory(context.env, slug),
    slug === undefined ? readBoard(context.env, period) : null,
  ]);
  if (category !== null) {
    const entries = await readCategoryBoard(context.env, category.slug);
    return context.html(categoryBoardPage(category, entries, user, categories));
  }
  const entries = points ?? (await readBoard(context.env, period));
  return context.html(boardPage(entries, period, user, categories));
});
