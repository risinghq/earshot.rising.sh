import { Page } from "../../ui/shell";
import { EmptyState } from "../../ui/empty";
import { type Game } from "../game/game";
import { type CategoryBoardEntry } from "../game/results";
import { type Choice } from "../game/rules";
import { type SignedInUser } from "../../account/auth";
import { type Preview } from "../catalog/sources";
import { finalPage } from "./final-page";
import { questionPage, revealPage } from "./round-page";

export function gamePage(
  game: Game,
  view:
    | { kind: "question"; preview: Preview; choices: Choice[] }
    | { kind: "reveal" }
    | { kind: "done" }
    | { kind: "busy" }
    | { kind: "error" },
  now: number,
  opts: { user?: SignedInUser | null; board?: CategoryBoardEntry[] } = {},
) {
  const user = opts.user ?? null;
  if (view.kind === "reveal")
    return revealPage(game, game.results[game.results.length - 1], user);
  if (view.kind === "done") return finalPage(game, user, opts.board ?? []);
  if (view.kind === "busy")
    return Page({
      title: "Clip service busy",
      user,
      children: (
        <EmptyState
          title="The clip service is busy"
          body="Deezer is answering too many requests right now. The round is kept; try again in a few seconds."
          action={{ href: `/play/${game.id}`, label: "Retry" }}
          heading="h1"
        />
      ),
    });
  if (view.kind === "error")
    return Page({
      title: "Preview unavailable",
      user,
      children: (
        <EmptyState
          title="The preview could not be loaded"
          body="The music service did not answer. Try again in a moment."
          action={{ href: "/", label: "Back to categories" }}
          heading="h1"
        />
      ),
    });
  return questionPage(game, view.preview, view.choices, now, user);
}
