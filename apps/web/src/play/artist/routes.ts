import { Hono } from "hono";
import { sessionUser } from "../../account/auth";
import type { Env } from "../../env";
import { database } from "../../platform/db";
import { notFoundPage } from "../../ui/not-found";
import {
  artistProfile,
  catalog,
  getCategory,
  listCategories,
} from "../catalog/catalog";
import { deezerSearchArtists } from "../catalog/sources";
import { readCategoryBoard } from "../game/results";
import { artistPage, artistsPage } from "./page";

export const artistApp = new Hono<{ Bindings: Env }>();

// The pick for a blend travels in the query: `with` holds the first artist's
// id and `n` its name, so choosing the second needs no stored state.
artistApp.get("/artists", async (context) => {
  const query = context.req.query("q")?.trim() ?? "";
  const withParam = context.req.query("with") ?? "";
  const withName = context.req.query("n")?.trim() ?? "";
  const picked = /^\d{1,10}$/.test(withParam)
    ? { id: Number(withParam), name: withName || `Artist ${withParam}` }
    : null;
  const search =
    query === ""
      ? Promise.resolve([])
      : deezerSearchArtists(query).catch((error: unknown) => {
          console.error("artist search failed", error);
          return null;
        });
  const [user, results] = await Promise.all([sessionUser(context), search]);
  if (query === "")
    return context.html(artistsPage(query, [], picked, [], user));
  // Genres are offered only when the search found nothing, so a good search
  // costs no D1 read.
  const genres =
    results === null || results.length === 0
      ? (await listCategories(database(context.env.DB)))
          .filter((category) => category.feed !== "mine")
          .slice(0, 6)
      : [];
  return context.html(
    artistsPage(query, results, picked, genres, user),
    results === null ? 502 : 200,
  );
});

artistApp.get("/artist/:ids", async (context) => {
  const user = await sessionUser(context);
  const category = await getCategory(
    context.env,
    `artist-${context.req.param("ids")}`,
  );
  if (category === null) return context.html(notFoundPage(user), 404);
  if (category.slug !== `artist-${context.req.param("ids")}`)
    return context.redirect(`/play/artist/${category.slug.slice(7)}`, 301);
  // The song strip loads the catalog the game will use, so Start reads it
  // from the cache. A feed failure only hides the strip; the game route
  // reports it.
  const [profiles, songs, entries] = await Promise.all([
    Promise.all(
      category
        .ref!.split(",")
        .map((id) => artistProfile(context.env, Number(id))),
    ),
    catalog(context.env, category, null).then(
      (tracks) => tracks.slice(0, 6),
      () => [],
    ),
    readCategoryBoard(context.env, category.slug),
  ]);
  return context.html(
    artistPage(
      category,
      profiles.filter((profile) => profile !== null),
      songs,
      entries,
      user,
    ),
  );
});
