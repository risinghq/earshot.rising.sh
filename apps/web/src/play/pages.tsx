import { PillButton, PillLink } from "../ui/pill";
import { RankedList } from "../ui/ranked";
import { Section } from "../ui/section";
import { Segmented } from "../ui/segmented";
import { Page } from "../ui/shell";
import { Stats } from "../ui/stat";
import { EmptyState } from "../ui/empty";
import type { Category } from "./catalog";
import type { Game, RoundResult } from "./game";
import type { BoardEntry, BoardPeriod } from "./results";
import { roundSeconds, roundsPerGame } from "./game";
import type { SignedInUser } from "../auth";
import type { Preview } from "./sources";

export function categoriesPage(
  categories: Category[],
  user: SignedInUser | null,
) {
  return Page({
    title: "Guess the song",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Guess the song</h1>
          <p class="meta">
            Ten rounds, {roundSeconds} seconds each. A right answer is worth up
            to 1,000 points, and the faster you answer the more it scores.
          </p>
        </div>
        <div class="play-grid">
          {categories.map((category) => (
            <section class="play-card" key={category.slug}>
              <h2>{category.name}</h2>
              {category.feed === "mine" && user === null ? (
                <p class="hint">
                  Your own top tracks. <a href="/auth/github">Sign in</a> to
                  play.
                </p>
              ) : (
                <>
                  <form method="post" action="/play">
                    <input
                      type="hidden"
                      name="category"
                      value={category.slug}
                    />
                    <div class="modes">
                      <button
                        class="pill small primary"
                        type="submit"
                        name="mode"
                        value="choices"
                      >
                        Choices
                      </button>
                      <button
                        class="pill small"
                        type="submit"
                        name="mode"
                        value="typed"
                      >
                        Type it
                      </button>
                    </div>
                  </form>
                  <form method="post" action="/play/room">
                    <input
                      type="hidden"
                      name="category"
                      value={category.slug}
                    />
                    <small class="hint">With friends</small>
                    <div class="modes">
                      <button
                        class="pill small"
                        type="submit"
                        name="mode"
                        value="choices"
                      >
                        Choices
                      </button>
                      <button
                        class="pill small"
                        type="submit"
                        name="mode"
                        value="typed"
                      >
                        Type it
                      </button>
                    </div>
                  </form>
                  {category.feed !== "mine" && (
                    <form method="post" action="/play/match">
                      <input
                        type="hidden"
                        name="category"
                        value={category.slug}
                      />
                      <small class="hint">With a stranger</small>
                      <div class="modes">
                        <button class="pill small" type="submit">
                          Play someone random
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
        <p class="meta">
          Charts come from Deezer and Apple Music. Every preview plays from
          Deezer, and each reveal links to the track. The{" "}
          <a href="/play/board">points board</a> ranks signed-in players.
        </p>
      </>
    ),
  });
}

const clipScript = (remainingMs: number) => `
const clip = document.getElementById("clip");
const bar = document.getElementById("count-bar");
const left = document.getElementById("count-left");
const answerForm = document.getElementById("answer-form");
let deadline = performance.now() + ${Math.max(0, remainingMs)};
clip.addEventListener("timeupdate", () => {
  if (clip.currentTime >= ${roundSeconds}) clip.pause();
});
const tick = setInterval(() => {
  const ms = Math.max(0, deadline - performance.now());
  left.textContent = String(Math.ceil(ms / 1000));
  bar.style.transform = "scaleX(" + ms / ${roundSeconds * 1000} + ")";
  if (ms <= 0) {
    clearInterval(tick);
    answerForm.submit();
  }
}, 200);
`;

export function questionPage(
  game: Game,
  preview: Preview,
  choices: string[],
  now: number,
  user: SignedInUser | null,
) {
  const remaining = roundSeconds * 1000 - (now - game.current!.servedAt);
  const action = `/play/${game.id}/answer`;
  return Page({
    title: `${game.categoryName} · Guess the song`,
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            {game.categoryName} · Round {game.results.length + 1} of{" "}
            {roundsPerGame} · Score {game.total}
          </p>
          <h1>Which song is this?</h1>
        </div>
        <Section
          title="Listen"
          aside={
            <span>
              <span id="count-left">{Math.ceil(remaining / 1000)}</span> s left
            </span>
          }
        >
          <div class="clip">
            {/* The player starts the clip; browsers block autoplay. */}
            <audio id="clip" src={preview.url} controls preload="auto" />
            <div class="share">
              <span id="count-bar" style="transform: scaleX(1)" />
            </div>
          </div>
          {game.mode === "choices" ? (
            <form
              id="answer-form"
              class="choices"
              method="post"
              action={action}
            >
              {choices.map((title) => (
                <button
                  class="pill choice"
                  type="submit"
                  name="choice"
                  value={title}
                >
                  {title}
                </button>
              ))}
            </form>
          ) : (
            <form id="answer-form" class="guess" method="post" action={action}>
              <div class="field">
                <label for="typed-answer">Song title</label>
                <input
                  id="typed-answer"
                  name="answer"
                  type="text"
                  autocomplete="off"
                  autofocus
                />
              </div>
              <div>
                <PillButton variant="primary" type="submit">
                  Guess
                </PillButton>
              </div>
            </form>
          )}
        </Section>
        <script dangerouslySetInnerHTML={{ __html: clipScript(remaining) }} />
      </>
    ),
  });
}

const linkService = (link: string) =>
  link.includes("apple.com") ? "Apple Music" : "Deezer";

function revealPage(
  game: Game,
  result: RoundResult,
  user: SignedInUser | null,
) {
  const heading = result.correct
    ? "Correct"
    : result.timedOut
      ? "Time ran out"
      : "Not quite";
  const last = game.results.length >= roundsPerGame;
  return Page({
    title: `${heading} · ${game.categoryName}`,
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            {game.categoryName} · Round {game.results.length} of {roundsPerGame}{" "}
            · Score {game.total}
          </p>
          <h1>{heading}</h1>
        </div>
        <Section title={result.title} aside={`+${result.score}`}>
          <div class="reveal">
            {result.cover && (
              <img src={result.cover} alt="" width="96" height="96" />
            )}
            <div class="track">
              <b>{result.title}</b>
              <small class="muted">{result.artist}</small>
              {result.link && (
                <a href={result.link}>Listen on {linkService(result.link)}</a>
              )}
            </div>
          </div>
          {!result.correct && result.answer && (
            <p class="meta">Your answer: {result.answer}</p>
          )}
          <form method="post" action={`/play/${game.id}/next`}>
            <PillButton variant="primary" type="submit">
              {last ? "See results" : "Next round"}
            </PillButton>
          </form>
        </Section>
      </>
    ),
  });
}

function resultLine(result: RoundResult) {
  return result.correct ? `+${result.score}` : result.timedOut ? "time" : "0";
}

export function finalPage(game: Game, user: SignedInUser | null) {
  const correct = game.results.filter((result) => result.correct).length;
  return Page({
    title: `Game over · ${game.categoryName}`,
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">{game.categoryName}</p>
          <h1>Game over</h1>
        </div>
        <Stats
          items={[
            { label: "Score", value: game.total },
            { label: "Correct", value: correct },
            { label: "Rounds", value: game.results.length },
          ]}
        />
        <Section title="Rounds">
          <ul class="rows">
            {game.results.map((result) => (
              <li>
                <div class="track">
                  <b>{result.title}</b>
                  <small>
                    {result.artist}
                    {result.answer && !result.correct
                      ? ` · your answer: ${result.answer}`
                      : ""}
                  </small>
                </div>
                <span class="count">{resultLine(result)}</span>
              </li>
            ))}
          </ul>
        </Section>
        {user === null && (
          <p class="meta">
            <a href="/auth/github">Sign in</a> to keep your points on the{" "}
            <a href="/play/board">board</a>.
          </p>
        )}
        <p>
          <PillLink href="/play" variant="primary">
            Play again
          </PillLink>
        </p>
      </>
    ),
  });
}

export function gamePage(
  game: Game,
  view:
    | { kind: "question"; preview: Preview; choices: string[] }
    | { kind: "reveal" }
    | { kind: "done" }
    | { kind: "busy" }
    | { kind: "error" },
  now: number,
  opts: { user?: SignedInUser | null } = {},
) {
  const user = opts.user ?? null;
  if (view.kind === "reveal")
    return revealPage(game, game.results[game.results.length - 1], user);
  if (view.kind === "done") return finalPage(game, user);
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
          action={{ href: "/play", label: "Back to categories" }}
          heading="h1"
        />
      ),
    });
  return questionPage(game, view.preview, view.choices, now, user);
}

const boardNames: Record<BoardPeriod, string> = {
  week: "This week",
  all: "All time",
};

export function boardPage(
  entries: BoardEntry[],
  period: BoardPeriod,
  user: SignedInUser | null,
) {
  return Page({
    title: "Points board · Guess the song",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Points board</h1>
          <p class="meta">
            Points from finished games, ranked by the total. The week starts
            Monday 00:00 UTC.
          </p>
        </div>
        <Segmented
          label="Board period"
          options={(["week", "all"] as const).map((value) => ({
            label: boardNames[value],
            href: `/play/board?period=${value}`,
            current: period === value,
          }))}
        />
        {entries.length === 0 ? (
          <EmptyState
            title="No scored games yet"
            body="Signed-in players land here when they finish a game. Play one to open the board."
            action={{ href: "/play", label: "Play a game" }}
          />
        ) : (
          <Section title="Top 50" aside={boardNames[period]}>
            <RankedList
              items={entries.map((entry) => ({
                title: entry.name,
                href: `/u/${encodeURIComponent(entry.name)}`,
                subtitle: `${entry.wins} ${entry.wins === 1 ? "win" : "wins"}`,
                plays: entry.points,
              }))}
            />
          </Section>
        )}
      </>
    ),
  });
}

export function matchPage(category: Category, user: SignedInUser | null) {
  return Page({
    title: `${category.name} · Play someone random`,
    user,
    children: (
      <div
        id="match"
        data-category={category.slug}
        data-signed-in={user ? "1" : ""}
        class="stack"
      >
        <div class="page-head">
          <p class="meta">{category.name}</p>
          <h1>Play someone random</h1>
        </div>
        <noscript>
          <p class="meta">
            Matchmaking needs JavaScript: it runs over a live connection.
          </p>
        </noscript>
        <p class="form-error" id="match-error" hidden />

        <section class="section" id="match-name-card" hidden>
          <div class="section-head">
            <h2>Pick a nickname</h2>
          </div>
          <div class="section-body">
            <p class="meta">
              Your opponent sees it during the game.{" "}
              <a href="/auth/github">Sign in</a> to play under your own name and
              keep points.
            </p>
            <form id="match-name-form" class="guess">
              <div class="field">
                <label for="match-nickname">Nickname</label>
                <input
                  id="match-nickname"
                  name="nickname"
                  type="text"
                  minlength={1}
                  maxlength={20}
                  autocomplete="off"
                  required
                />
              </div>
              <div>
                <button class="pill primary" type="submit">
                  Find a match
                </button>
              </div>
            </form>
          </div>
        </section>

        <section class="section" id="match-search-card" hidden>
          <div class="section-head">
            <h2>Searching for a player</h2>
            <small class="label">
              <span id="match-waited">0</span> s
            </small>
          </div>
          <div class="section-body">
            <p class="meta" id="match-status">
              Waiting for someone else to pick {category.name}…
            </p>
            <div class="modes" id="match-actions" hidden>
              <form method="post" action="/play">
                <input type="hidden" name="category" value={category.slug} />
                <input type="hidden" name="mode" value="choices" />
                <button class="pill" type="submit">
                  Play solo
                </button>
              </form>
              <button class="pill" id="match-stop" type="button">
                Keep waiting
              </button>
            </div>
          </div>
        </section>

        <script src="/match.js" defer />
      </div>
    ),
  });
}

export function feedErrorPage(name: string, user: SignedInUser | null) {
  return Page({
    title: "Category unavailable",
    user,
    children: (
      <EmptyState
        title={`${name} is not available right now`}
        body="The music feed did not answer. Pick another category or try again in a moment."
        action={{ href: "/play", label: "Back to categories" }}
        heading="h1"
      />
    ),
  });
}
