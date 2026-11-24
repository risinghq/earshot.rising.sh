import { ScriptTag } from "../../ui/assets";
import { PillButton, PillLink } from "../../ui/pill";
import { Page } from "../../ui/shell";
import { SaveScoreCard } from "../../ui/empty";
import { forYouSlug } from "../catalog/foryou";
import { type Game } from "../game/game";
import {
  type CategoryBoardEntry,
  categoryBoardDays,
  categoryBoardSize,
} from "../game/results";
import { byline } from "../game/rules";
import { providerHref, type SignedInUser } from "../../account/auth";
import {
  bestStreak,
  coverTile,
  crossIcon,
  quitIcon,
  trophyIcon,
} from "../game/parts";

export function finalPage(
  game: Game,
  user: SignedInUser | null,
  board: CategoryBoardEntry[],
) {
  const correct = game.results.filter((result) => result.correct).length;
  const fastest = game.results
    .filter((result) => result.correct)
    .reduce((best, result) => Math.min(best, result.elapsedMs), Infinity);
  const hasBoard = game.categorySlug !== forYouSlug;
  const placed = hasBoard ? placeOnBoard(board, user, game.total) : null;
  // The board keeps each player's best, so only a signed-in player's own
  // entry says whether this game beat it.
  const ownBest = board.find((entry) => entry.name === user?.name)?.score ?? 0;
  const newBest = hasBoard && user !== null && game.total > ownBest;
  const emptyBoard = hasBoard && user === null && board.length === 0;
  const here = `/play/${game.id}`;
  const saveTitle =
    user !== null || game.total === 0
      ? null
      : placed?.rank
        ? `That's #${placed.rank} on ${game.categoryName}`
        : `Keep your ${game.total.toLocaleString("en-US")} points`;
  const stats = [
    { label: "Correct", value: `${correct}/${game.results.length}` },
    { label: "Best streak", value: String(bestStreak(game.results)) },
    {
      label: "Fastest",
      value: fastest === Infinity ? "—" : `${(fastest / 1000).toFixed(1)} s`,
    },
  ];
  return Page({
    title: `Game over · ${game.categoryName}`,
    user,
    chrome: "game",
    children: (
      <div id="game">
        <div class="results-head">
          <a class="results-quit" href="/" aria-label="Back to genres">
            {quitIcon}
          </a>
          <b>{game.categoryName}</b>
        </div>
        <div
          id="round"
          class={hasBoard ? "results" : "results no-board"}
          data-phase="done"
          aria-live="polite"
        >
          <div class="results-main">
            <section class="score-card" aria-labelledby="score-label">
              <div class="score-top">
                <h1 class="score-label" id="score-label">
                  Game over
                </h1>
                {newBest && <span class="score-best">New best</span>}
              </div>
              <p class="score-n">{game.total.toLocaleString("en-US")}</p>
              {placed?.rank && (
                <p class="score-rank">
                  #{placed.rank} on {game.categoryName}
                </p>
              )}
              <ol
                class="score-pips"
                aria-label={`${correct} of ${game.results.length} right`}
              >
                {game.results.map((result) => (
                  <li class={result.correct ? "is-right" : ""} />
                ))}
              </ol>
            </section>
            <dl class="results-stats">
              {stats.map((stat) => (
                <div>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
            {saveTitle !== null && (
              <SaveScoreCard title={saveTitle} next={here} />
            )}
            <div class="results-actions">
              <form method="post" action="/play">
                <input
                  type="hidden"
                  name="category"
                  value={game.categorySlug}
                />
                <input type="hidden" name="mode" value={game.mode} />
                <PillButton type="submit" variant="primary" large>
                  Play again
                </PillButton>
              </form>
              <PillLink href="/" large>
                Genres
              </PillLink>
            </div>
          </div>
          {emptyBoard && (
            <section class="results-card results-board board-empty">
              <h2>
                Top scores <small>Last {categoryBoardDays} days</small>
              </h2>
              <div class="board-empty-in">
                <span class="board-trophy" aria-hidden="true">
                  {trophyIcon}
                </span>
                <b>No scores yet</b>
                <p>
                  Nobody has finished {game.categoryName} in the last{" "}
                  {categoryBoardDays} days. Sign in and your{" "}
                  {game.total.toLocaleString("en-US")} takes #1.
                </p>
                <ol class="board-ghosts" aria-hidden="true">
                  <li />
                  <li />
                  <li />
                </ol>
                <a class="board-claim" href={providerHref("google", here)}>
                  Sign in to claim it
                </a>
              </div>
            </section>
          )}
          {placed && !emptyBoard && (
            <section class="results-card results-board">
              <h2>
                Top scores <small>Last {categoryBoardDays} days</small>
              </h2>
              <ol class="board-rows">
                {placed.rows.map((row) => (
                  <li class={row.you ? "is-you" : ""}>
                    <span class="board-rank">{row.rank}</span>
                    <span class="board-name">
                      {row.you ? (
                        "You"
                      ) : (
                        <a href={`/u/${encodeURIComponent(row.name)}`}>
                          {row.name}
                        </a>
                      )}
                    </span>
                    <span class="board-score">
                      {row.score.toLocaleString("en-US")}
                    </span>
                  </li>
                ))}
              </ol>
              {user === null && saveTitle === null && (
                <p class="board-foot">
                  <a href={providerHref("google", here)}>Sign in</a> to put your
                  next score on the board.
                </p>
              )}
            </section>
          )}
          <section class="results-card results-rounds">
            <h2>Rounds</h2>
            <ol class="round-rows">
              {game.results.map((result, index) => (
                <li>
                  <span class="round-i" aria-hidden="true">
                    {index + 1}
                  </span>
                  {coverTile(result.cover, 44)}
                  <span class="round-song">
                    <b>{result.title}</b>
                    <small>
                      {byline(result)}
                      {result.timedOut
                        ? " · no answer"
                        : !result.correct && result.answer
                          ? ` · you said ${result.answer}`
                          : ""}
                    </small>
                  </span>
                  <span
                    class={`round-points ${result.correct ? "is-right" : "is-wrong"}`}
                  >
                    {result.correct ? `+${result.score}` : crossIcon}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <ScriptTag name="solo" />
      </div>
    ),
  });
}

const boardRowsShown = 5;

// Where this game's score lands among the other players on the category
// board. The board keeps each player's best, so the signed-in player's own
// entry is left out and this game stands in for it. A score below a full
// board has no rank; the board then shows without the player's row.
function placeOnBoard(
  board: CategoryBoardEntry[],
  user: SignedInUser | null,
  total: number,
) {
  const others = board.filter((entry) => entry.name !== user?.name);
  const above = others.filter((entry) => entry.score > total).length;
  const rank = total > 0 && above < categoryBoardSize ? above + 1 : null;
  const rows = others.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    you: false,
  }));
  if (rank === null) return { rank, rows: rows.slice(0, boardRowsShown) };
  const you = { name: "You", score: total, rank, you: true };
  const before = rows.slice(0, above).slice(0, boardRowsShown - 1);
  const after = rows
    .slice(above)
    .map((row) => ({ ...row, rank: row.rank + 1 }));
  return {
    rank,
    rows: [...before, you, ...after].slice(0, boardRowsShown),
  };
}
