import type { Context } from "hono";
import { sessionUser } from "../account/auth";
import type { Env } from "../env";
import { notFoundPage } from "../ui/not-found";
import {
  catalog,
  enoughTracks,
  getCategory,
  type Category,
} from "./catalog/catalog";
import { eraName } from "./catalog/eras";
import { forYouCategory, forYouMix, forYouSlug } from "./catalog/foryou";
import { byDecade } from "./catalog/pool";
import type { Candidate } from "./catalog/sources";
import { parseClipKind, type ClipKind } from "./game/clip";
import type { Mode } from "./game/game";
import { anonKey, playerKeyOf } from "./game/outcomes";
import { parseMode } from "./game/quiz";
import { feedErrorPage } from "./hub/page";

// One entry check for both game kinds: same form fields, same category and
// mode validation, same catalogue fetch, same minimum track count.
export async function gameInput(
  context: Context<{ Bindings: Env }>,
  forYou = false,
): Promise<
  | {
      category: Category;
      mode: Mode;
      tracks: Candidate[];
      userId: number | null;
      playerKey: string;
      clip: ClipKind | null;
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
  // The intro clip is a paid feature; any other post leaves it unset, which
  // keeps the room's current choice on a category switch.
  const clip = user?.tier === "paid" ? parseClipKind(body.clip) : null;
  // A room's switch keeps its host in the room's category picker.
  const room = context.req.param("code");
  const back = room ? `/?room=${room}&mode=${mode}` : "/";
  // For you is a solo-only game: its pool is one player's mix, so a room or a
  // match would sit everyone in the creator's taste.
  if (slug === forYouSlug) {
    if (!forYou) return context.html(notFoundPage(user), 404);
    const anon = anonKey(context);
    const playerKey = playerKeyOf(user?.id ?? null, anon);
    const tracks = await forYouMix(
      context.env,
      playerKey,
      user?.id ?? null,
      mode,
    );
    if (!enoughTracks(forYouCategory, tracks))
      return context.html(feedErrorPage(forYouCategory.name, user), 502);
    return {
      category: forYouCategory,
      mode,
      tracks,
      userId: user?.id ?? null,
      playerKey,
      clip,
    };
  }
  const category = await getCategory(context.env, slug);
  if (category === null) return context.html(notFoundPage(user), 404);
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
        : { ...category, name: `${category.name} · ${eraName(era)}` },
    mode,
    tracks,
    userId: user?.id ?? null,
    playerKey: playerKeyOf(user?.id ?? null, anon),
    clip,
  };
}
