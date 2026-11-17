import { PillButton, PillLink } from "../ui/pill";
import { RankedList } from "../ui/ranked";
import { Section } from "../ui/section";
import { Segmented } from "../ui/segmented";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import { Stats } from "../ui/stat";
import { EmptyState } from "../ui/empty";
import type { Category } from "./catalog";
import { forYouSlug } from "./foryou";
import type { Game, RoundResult } from "./game";
import type { BoardEntry, BoardPeriod, CategoryBoardEntry } from "./results";
import { categoryBoardDays } from "./results";
import { roundSeconds, roundsPerGame } from "./game";
import type { SignedInUser } from "../auth";
import type { ArtistHit, Preview } from "./sources";

function playForms(category: Category) {
  return (
    <>
      <form method="post" action="/play">
        <input type="hidden" name="category" value={category.slug} />
        <div class="modes">
          <button
            class="pill small primary"
            type="submit"
            name="mode"
            value="choices"
          >
            Choices
          </button>
          <button class="pill small" type="submit" name="mode" value="typed">
            Type it
          </button>
        </div>
      </form>
      <form method="post" action="/play/room">
        <input type="hidden" name="category" value={category.slug} />
        <small class="hint">With friends</small>
        <div class="modes">
          <button class="pill small" type="submit" name="mode" value="choices">
            Choices
          </button>
          <button class="pill small" type="submit" name="mode" value="typed">
            Type it
          </button>
        </div>
      </form>
      {category.feed !== "mine" && (
        <form method="post" action="/play/match">
          <input type="hidden" name="category" value={category.slug} />
          <small class="hint">With a stranger</small>
          <div class="modes">
            <button class="pill small" type="submit">
              Play someone random
            </button>
          </div>
        </form>
      )}
    </>
  );
}

export function CategoryBoard({ entries }: { entries: CategoryBoardEntry[] }) {
  if (entries.length === 0)
    return <p class="hint">No scores in the last {categoryBoardDays} days.</p>;
  return (
    <ul class="rows">
      {entries.map((entry, index) => (
        <li key={entry.name}>
          <span class="rank">{index + 1}</span>
          <div class="track">
            <b>
              <a href={`/u/${encodeURIComponent(entry.name)}`}>{entry.name}</a>
            </b>
          </div>
          <span class="count">{entry.score.toLocaleString("en-US")}</span>
        </li>
      ))}
    </ul>
  );
}

export type PlayWho = "solo" | "room" | "stranger";

const whoActions: Record<PlayWho, string> = {
  solo: "/play",
  room: "/play/room",
  stranger: "/play/match",
};
const setupScript = `
const setup = document.getElementById("play-setup");
const actions = { solo: "/play", room: "/play/room", stranger: "/play/match" };
setup.addEventListener("change", () => {
  const who = setup.querySelector('input[name="who"]:checked').value;
  const mode = setup.querySelector('input[name="mode"]:checked').value;
  document.getElementById("mode-field").disabled = who === "stranger";
  document.querySelectorAll("form.tile").forEach((tile) => {
    if (!tile.hasAttribute("data-solo")) tile.action = actions[who];
    tile.querySelector('input[name="mode"]').value = mode;
  });
});
`;

const eraLabel = (decade: number) => `${String(decade).slice(2)}s`;

function tile(
  category: Category,
  eras: number[],
  who: PlayWho,
  mode: "choices" | "typed",
  user: SignedInUser | null,
) {
  const locked = category.feed === "mine" && user === null;
  if (locked)
    return (
      <div class="tile" key={category.slug}>
        <a href="/auth/github">
          <span class="tile-name">{category.name}</span>
          <span class="tile-go">Sign in</span>
        </a>
      </div>
    );
  return (
    <form
      class="tile"
      key={category.slug}
      method="post"
      action={whoActions[who]}
    >
      <input type="hidden" name="category" value={category.slug} />
      <input type="hidden" name="mode" value={mode} />
      {eras.length === 0 ? (
        <>
          <button type="submit">
            <span class="tile-name">{category.name}</span>
          </button>
          <span class="tile-links">
            <a
              class="tile-score"
              href={`/play/board?category=${category.slug}`}
            >
              Scores
            </a>
          </span>
        </>
      ) : (
        <>
          <span class="tile-name">
            {category.name}
            <a
              class="tile-score"
              href={`/play/board?category=${category.slug}`}
            >
              Scores
            </a>
          </span>
          <span class="tile-eras">
            <button class="chip" type="submit">
              All
            </button>
            {eras.map((era) => (
              <button class="chip" type="submit" name="era" value={era}>
                {eraLabel(era)}
              </button>
            ))}
          </span>
        </>
      )}
    </form>
  );
}

// The For you tile is a solo game on every "who" choice, so the setup script
// leaves its action alone; the muted line stands where a Scores link would.
function forYouTile(mode: "choices" | "typed", cold: boolean) {
  return (
    <form class="tile" method="post" action="/play" data-solo>
      <input type="hidden" name="category" value={forYouSlug} />
      <input type="hidden" name="mode" value={mode} />
      <button type="submit">
        <span class="tile-name">For you</span>
      </button>
      <span class="tile-links">
        <span class="tile-score">
          {cold
            ? "Play a few games and this learns your taste"
            : "Tracks you know, plus new ones"}
        </span>
      </span>
    </form>
  );
}

export function categoriesPage(
  categories: Category[],
  eras: Record<string, number[]>,
  user: SignedInUser | null,
  who: PlayWho = "solo",
  mode: "choices" | "typed" = "choices",
  forYouColdStart = true,
) {
  const whoChecked = (value: PlayWho) =>
    who === value ? { checked: true } : {};
  const modeChecked = (value: string) =>
    mode === value ? { checked: true } : {};
  return Page({
    title: "Guess the song",
    user,
    nav: "play",
    children: (
      <>
        <div class="page-head">
          <h1>Guess the song</h1>
          <p class="meta">
            Ten rounds, {roundSeconds} seconds each. A right answer is worth up
            to 1,000 points, and the faster you answer the more it scores.
          </p>
        </div>
        <form class="play-setup" id="play-setup" method="get" action="/play">
          <fieldset>
            <legend>How do you want to play?</legend>
            <div class="segmented">
              <label>
                <input
                  type="radio"
                  name="who"
                  value="solo"
                  {...whoChecked("solo")}
                />
                Solo
              </label>
              <label>
                <input
                  type="radio"
                  name="who"
                  value="room"
                  {...whoChecked("room")}
                />
                Room with friends
              </label>
              <label>
                <input
                  type="radio"
                  name="who"
                  value="stranger"
                  {...whoChecked("stranger")}
                />
                A stranger
              </label>
            </div>
          </fieldset>
          <fieldset id="mode-field" disabled={who === "stranger"}>
            <legend>Answers</legend>
            <div class="segmented">
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="choices"
                  {...modeChecked("choices")}
                />
                Choices
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  value="typed"
                  {...modeChecked("typed")}
                />
                Type it
              </label>
            </div>
          </fieldset>
          <noscript>
            <button class="pill" type="submit">
              Apply
            </button>
          </noscript>
        </form>
        <script dangerouslySetInnerHTML={{ __html: setupScript }} />
        <Section title="Play an artist">
          <form method="get" action="/play/artists" class="guess">
            <div class="field">
              <label for="artist-q">Artist</label>
              <input
                id="artist-q"
                name="q"
                type="text"
                autocomplete="off"
                required
              />
            </div>
            <div class="modes">
              <PillButton variant="primary" type="submit">
                Search artists
              </PillButton>
            </div>
          </form>
          <p class="hint">
            Play one artist's top tracks, or blend two artists into one game.
          </p>
        </Section>
        <div class="tiles">
          {forYouTile(mode, forYouColdStart)}
          {categories.map((category) =>
            tile(category, eras[category.slug] ?? [], who, mode, user),
          )}
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

export function questionPage(
  game: Game,
  preview: Preview,
  choices: string[],
  now: number,
  user: SignedInUser | null,
) {
  const remaining = Math.max(
    0,
    roundSeconds * 1000 -
      (now - (game.current!.startedAt ?? game.current!.servedAt)),
  );
  const action = `/play/${game.id}/answer`;
  return Page({
    title: `${game.categoryName} · Guess the song`,
    user,
    children: (
      <div id="game">
        <div
          id="round"
          data-phase="question"
          data-src={preview.url}
          data-game={game.id}
          data-remaining={String(remaining)}
          aria-live="polite"
        >
          <div class="page-head">
            <p class="meta">
              {game.categoryName} · Round {game.results.length + 1} of{" "}
              {roundsPerGame} · Score {game.total}
            </p>
            <h1>Which song is this?</h1>
          </div>
          <div class="game-grid">
            <ClipPlayer
              src={preview.url}
              audioId="clip"
              toggleId="clip-toggle"
              barId="count-bar"
              leftId="count-left"
              volumeId="clip-volume"
            />
            <div>
              {game.mode === "choices" ? (
                <form
                  id="answer-form"
                  class="choices"
                  method="post"
                  action={action}
                  data-solo
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
                <form
                  id="answer-form"
                  class="guess"
                  method="post"
                  action={action}
                  data-solo
                >
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
            </div>
          </div>
        </div>
        <script src="/solo.js" defer />
      </div>
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
  let streak = 0;
  for (let i = game.results.length - 1; i >= 0 && game.results[i].correct; i--)
    streak += 1;
  const check = (
    <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
    </svg>
  );
  const cross = (
    <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
  );
  const choiceState = (title: string) =>
    title === result.title
      ? "is-right"
      : !result.correct && title === result.answer
        ? "is-wrong"
        : "";
  return Page({
    title: `${heading} · ${game.categoryName}`,
    user,
    children: (
      <div id="game">
        <div
          id="round"
          data-phase="reveal"
          data-game={game.id}
          data-correct={result.correct ? "1" : ""}
          data-last={last ? "1" : ""}
          data-score={String(result.score)}
          aria-live="polite"
        >
          <div class="page-head">
            <p class="meta">
              {game.categoryName} · Round {game.results.length} of{" "}
              {roundsPerGame} · Score {game.total}
            </p>
            <h1>{heading}</h1>
          </div>
          <div class="game-grid">
            <div class="stack">
              <div class="player reveal-card">
                {result.cover && (
                  <img src={result.cover} alt="" width="96" height="96" />
                )}
                <div class="track">
                  <b>{result.title}</b>
                  <small class="muted">{result.artist}</small>
                  {result.link && (
                    <a href={result.link}>
                      Listen on {linkService(result.link)}
                    </a>
                  )}
                </div>
                <span
                  class={`reveal-points${result.score > 0 ? "" : " is-none"}`}
                  data-points={result.score}
                >
                  +{result.score}
                </span>
              </div>
              {streak >= 2 && <p class="streak">{streak} in a row</p>}
              <form method="post" action={`/play/${game.id}/next`} data-solo>
                <PillButton variant="primary" type="submit">
                  {last ? "See results" : "Next round"}
                </PillButton>
              </form>
              <details class="report">
                <summary>Report this clip</summary>
                <form
                  class="report-form"
                  method="post"
                  action="/play/report"
                  data-solo
                >
                  <input type="hidden" name="track" value={result.trackKey} />
                  <input type="hidden" name="title" value={result.title} />
                  <input type="hidden" name="artist" value={result.artist} />
                  <input
                    type="hidden"
                    name="category"
                    value={game.categorySlug}
                  />
                  <input type="hidden" name="back" value={`/play/${game.id}`} />
                  <select name="reason" required>
                    <option value="wrong_song">Wrong song</option>
                    <option value="bad_clip">Bad clip</option>
                    <option value="wrong_title">Wrong title</option>
                    <option value="other">Other</option>
                  </select>
                  <PillButton small type="submit">
                    Send report
                  </PillButton>
                </form>
              </details>
            </div>
            <div>
              {result.choices.length > 0 ? (
                <div class="choices reveal-choices">
                  {result.choices.map((title) => (
                    <button
                      class={`pill choice ${choiceState(title)}`}
                      type="button"
                      disabled
                    >
                      {title === result.title && check}
                      {!result.correct && title === result.answer && cross}
                      <span class="choice-label">{title}</span>
                      {title === result.title && result.correct && (
                        <span class="burst" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <dl class="reveal-typed">
                  <div>
                    <dt>You typed</dt>
                    <dd class={result.correct ? "good" : ""}>
                      {result.answer === null || result.answer === ""
                        ? result.timedOut
                          ? "Nothing — time ran out"
                          : "Nothing"
                        : result.answer}
                    </dd>
                  </div>
                  <div>
                    <dt>Right answer</dt>
                    <dd class="good">
                      {check} {result.title}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          </div>
        </div>
        <script src="/solo.js" defer />
      </div>
    ),
  });
}

function resultLine(result: RoundResult) {
  return result.correct ? `+${result.score}` : result.timedOut ? "time" : "0";
}

export function artistsPage(
  query: string,
  results: ArtistHit[],
  picked: { id: number; name: string } | null,
  user: SignedInUser | null,
) {
  return Page({
    title: "Find an artist · Guess the song",
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            <a href="/play">Guess the song</a>
          </p>
          <h1>Find an artist</h1>
          <p class="meta">
            {picked === null
              ? "Play one artist's top tracks, or blend two artists into one game."
              : `Blending with ${picked.name}. Pick the second artist, or start over.`}
          </p>
        </div>
        <Section title="Artist search">
          <form method="get" action="/play/artists" class="guess">
            {picked !== null && (
              <>
                <input type="hidden" name="with" value={picked.id} />
                <input type="hidden" name="n" value={picked.name} />
              </>
            )}
            <div class="field">
              <label for="artist-q">
                {picked === null ? "Artist" : "Second artist"}
              </label>
              <input
                id="artist-q"
                name="q"
                type="text"
                autocomplete="off"
                value={query}
                required
              />
            </div>
            <div class="modes">
              <PillButton variant="primary" type="submit">
                Search artists
              </PillButton>
              {picked !== null && (
                <PillLink href={`/play/artists?q=${encodeURIComponent(query)}`}>
                  Start over
                </PillLink>
              )}
            </div>
          </form>
        </Section>
        {query !== "" &&
          (results.length === 0 ? (
            <EmptyState
              title="No artists found"
              body={`Deezer has no artist matching "${query}". Try another spelling.`}
            />
          ) : (
            <Section title="Results" aside={`${results.length} on Deezer`}>
              <ul class="rows hits">
                {results.map((artist) => (
                  <li key={artist.id}>
                    {artist.picture !== null && (
                      <img
                        class="avatar"
                        src={artist.picture}
                        alt=""
                        width="48"
                        height="48"
                        loading="lazy"
                      />
                    )}
                    <div class="track">
                      <b>{artist.name}</b>
                      <small>{artist.fans.toLocaleString("en-US")} fans</small>
                    </div>
                    {picked === null ? (
                      <span class="modes">
                        <PillLink
                          small
                          href={`/play/artists?q=${encodeURIComponent(query)}&with=${artist.id}&n=${encodeURIComponent(artist.name)}`}
                        >
                          Blend
                        </PillLink>
                        <PillLink
                          small
                          variant="primary"
                          href={`/play/artist/${artist.id}`}
                        >
                          Play
                        </PillLink>
                      </span>
                    ) : artist.id === picked.id ? (
                      <PillLink small href={`/play/artist/${artist.id}`}>
                        Play solo
                      </PillLink>
                    ) : (
                      <span class="modes">
                        <PillLink small href={`/play/artist/${artist.id}`}>
                          Play
                        </PillLink>
                        <PillLink
                          small
                          variant="primary"
                          href={`/play/artist/${picked.id}-${artist.id}`}
                        >
                          Blend
                        </PillLink>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        <p class="meta">
          Artist names, pictures and fan counts come from Deezer. Each reveal
          links to the track on Deezer.
        </p>
      </>
    ),
  });
}

export function artistPage(
  category: Category,
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
) {
  return Page({
    title: `${category.name} · Guess the song`,
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            <a href="/play/artists">Find an artist</a>
          </p>
          <h1>{category.name}</h1>
          <p class="meta">
            Ten rounds of top tracks, {roundSeconds} seconds each.
          </p>
        </div>
        <Section title="Start a game">{playForms(category)}</Section>
        <Section title="Top scores" aside={`Last ${categoryBoardDays} days`}>
          <CategoryBoard entries={entries} />
        </Section>
      </>
    ),
  });
}

export function finalPage(
  game: Game,
  user: SignedInUser | null,
  board: CategoryBoardEntry[],
) {
  const correct = game.results.filter((result) => result.correct).length;
  return Page({
    title: `Game over · ${game.categoryName}`,
    user,
    children: (
      <div id="game">
        <div id="round" data-phase="done" aria-live="polite">
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
          <div class="duo">
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
            {game.categorySlug !== forYouSlug && (
              <Section
                title="Top scores"
                aside={`${game.categoryName} · last ${categoryBoardDays} days`}
              >
                <CategoryBoard entries={board} />
              </Section>
            )}
          </div>
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
        </div>
        <script src="/solo.js" defer />
      </div>
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

export function categoryBoardPage(
  name: string,
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
) {
  return Page({
    title: `${name} scores · Guess the song`,
    user,
    children: (
      <>
        <div class="page-head">
          <h1>{name}</h1>
          <p class="meta">Top scores in this category.</p>
        </div>
        <Section title="Top scores" aside={`Last ${categoryBoardDays} days`}>
          <CategoryBoard entries={entries} />
        </Section>
      </>
    ),
  });
}

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

export function matchPage(
  category: Category,
  user: SignedInUser | null,
  era: number | null = null,
) {
  return Page({
    title: `${category.name} · Play someone random`,
    user,
    children: (
      <div
        id="match"
        data-category={category.slug}
        data-era={era ?? ""}
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
