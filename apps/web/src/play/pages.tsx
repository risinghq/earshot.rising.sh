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
import { tileCovers, type TileFacts } from "./hub";
import type { Game, RoundResult } from "./game";
import type { BoardEntry, BoardPeriod, CategoryBoardEntry } from "./results";
import { categoryBoardDays } from "./results";
import { roundSeconds, roundsPerGame } from "./game";
import { defaultMode, modes, type Choice, type Mode } from "./quiz";
import type { SignedInUser } from "../auth";
import type { ArtistHit, Preview } from "./sources";

export const modeNames: Record<Mode, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
};

const modeHints: Record<Mode, string> = {
  easy: "Titles with artists",
  normal: "Titles only",
  hard: "Type the title",
};

function modeButtons(primary: boolean) {
  return (
    <div class="modes">
      {modes.map((mode) => (
        <button
          class={`pill small${primary && mode === defaultMode ? " primary" : ""}`}
          type="submit"
          name="mode"
          value={mode}
          title={modeHints[mode]}
        >
          {modeNames[mode]}
        </button>
      ))}
    </div>
  );
}

function playForms(category: Category) {
  return (
    <>
      <form method="post" action="/play">
        <input type="hidden" name="category" value={category.slug} />
        {modeButtons(true)}
      </form>
      <form method="post" action="/play/room">
        <input type="hidden" name="category" value={category.slug} />
        <small class="hint">With friends</small>
        {modeButtons(false)}
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

// Three looks for the same hub markup, compared through ?variant=. The first
// is the default.
export const hubVariants = ["crate", "sleeve", "tracklist"] as const;
export type HubVariant = (typeof hubVariants)[number];

const whoActions: Record<PlayWho, string> = {
  solo: "/play",
  room: "/play/room",
  stranger: "/play/match",
};
const setupScript = `
const setup = document.getElementById("play-setup");
const actions = { solo: "/play", room: "/play/room", stranger: "/play/match" };
const hints = ${JSON.stringify(modeHints)};
setup.addEventListener("change", () => {
  const who = setup.querySelector('input[name="who"]:checked').value;
  const mode = setup.querySelector('input[name="mode"]:checked').value;
  document.getElementById("mode-field").disabled = who === "stranger";
  document.getElementById("mode-hint").textContent = hints[mode];
  document.querySelectorAll("form.tile").forEach((tile) => {
    if (!tile.hasAttribute("data-solo")) tile.action = actions[who];
    tile.querySelector('input[name="mode"]').value = mode;
  });
});
`;

const eraLabel = (decade: number) => `${String(decade).slice(2)}s`;

const soundMark = (
  <svg class="sound-mark" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="1" y="7" width="2.4" height="5" rx="1.2" />
    <rect x="5.2" y="3.5" width="2.4" height="11" rx="1.2" />
    <rect x="9.4" y="5.5" width="2.4" height="7" rx="1.2" />
    <rect x="13.6" y="4" width="2.4" height="10" rx="1.2" />
  </svg>
);

// Four covers make a mosaic; fewer show the first one whole, and none shows
// the mark on a tint.
function tileArt(covers: string[]) {
  if (covers.length === 0)
    return (
      <span class="tile-art is-blank" aria-hidden="true">
        {soundMark}
      </span>
    );
  const shown = covers.length >= tileCovers ? covers : covers.slice(0, 1);
  return (
    <span
      class={shown.length === 1 ? "tile-art is-single" : "tile-art"}
      aria-hidden="true"
    >
      {shown.map((src) => (
        <img
          src={src}
          alt=""
          width="120"
          height="120"
          loading="lazy"
          decoding="async"
        />
      ))}
    </span>
  );
}

function tileText(name: string, note?: string) {
  return (
    <span class="tile-text">
      <span class="tile-name">{name}</span>
      {note && <span class="tile-note">{note}</span>}
    </span>
  );
}

// The tile starts a game on the whole pool; a decade chip narrows it.
function tile(
  category: Category,
  facts: TileFacts,
  who: PlayWho,
  mode: Mode,
  user: SignedInUser | null,
) {
  if (category.feed === "mine" && user === null)
    return (
      <div class="tile" key={category.slug}>
        <a class="tile-main" href="/auth/github">
          {tileArt([])}
          {tileText(category.name, "Sign in to play your own plays")}
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
      <button class="tile-main" type="submit">
        {tileArt(facts.covers)}
        {tileText(
          category.name,
          category.feed === "mine" ? "Songs from your plays" : undefined,
        )}
      </button>
      {facts.eras.length > 0 && (
        <span
          class="tile-eras"
          role="group"
          aria-label={`${category.name} by decade`}
        >
          {facts.eras.map((era) => (
            <button
              class="chip"
              type="submit"
              name="era"
              value={era}
              aria-label={`${category.name}, ${era}s`}
            >
              {eraLabel(era)}
            </button>
          ))}
        </span>
      )}
    </form>
  );
}

// The For you tile is a solo game on every "who" choice, so the setup script
// leaves its action alone.
function forYouTile(mode: Mode, cold: boolean) {
  return (
    <form class="tile" method="post" action="/play" data-solo>
      <input type="hidden" name="category" value={forYouSlug} />
      <input type="hidden" name="mode" value={mode} />
      <button class="tile-main" type="submit">
        {tileArt([])}
        {tileText(
          "For you",
          cold
            ? "Play a few games and this learns your taste"
            : "Tracks you know, plus new ones",
        )}
      </button>
    </form>
  );
}

export interface HubOptions {
  categories: Category[];
  facts: Record<string, TileFacts>;
  user: SignedInUser | null;
  who?: PlayWho;
  mode?: Mode;
  forYouColdStart?: boolean;
  variant?: HubVariant;
}

export function hubPage({
  categories,
  facts,
  user,
  who = "solo",
  mode = defaultMode,
  forYouColdStart = true,
  variant = "crate",
}: HubOptions) {
  const whoChecked = (value: PlayWho) =>
    who === value ? { checked: true } : {};
  return Page({
    title: "Guess the song",
    user,
    nav: "play",
    bodyClass: `hub-${variant}`,
    children: (
      <>
        <div class="page-head">
          <h1>Guess the song</h1>
          <p class="meta">
            Ten clips, {roundSeconds} seconds each. Pick a category and name the
            song; a faster right answer scores more.
          </p>
        </div>
        <form class="play-setup" id="play-setup" method="get" action="/">
          <fieldset>
            <legend>Play</legend>
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
                Friends
              </label>
              <label>
                <input
                  type="radio"
                  name="who"
                  value="stranger"
                  {...whoChecked("stranger")}
                />
                Stranger
              </label>
            </div>
          </fieldset>
          <fieldset id="mode-field" disabled={who === "stranger"}>
            <legend>Difficulty</legend>
            <div class="segmented">
              {modes.map((value) => (
                <label title={modeHints[value]}>
                  <input
                    type="radio"
                    name="mode"
                    value={value}
                    {...(mode === value ? { checked: true } : {})}
                  />
                  {modeNames[value]}
                </label>
              ))}
            </div>
            <p class="hint" id="mode-hint">
              {modeHints[mode]}
            </p>
          </fieldset>
          <noscript>
            <button class="pill" type="submit">
              Apply
            </button>
          </noscript>
        </form>
        <script dangerouslySetInnerHTML={{ __html: setupScript }} />
        <div class="tiles">
          {forYouTile(mode, forYouColdStart)}
          {categories.map((category) =>
            tile(
              category,
              facts[category.slug] ?? { eras: [], covers: [] },
              who,
              mode,
              user,
            ),
          )}
        </div>
        <section class="artist-search" aria-labelledby="artist-title">
          <h2 id="artist-title">Play an artist</h2>
          <form method="get" action="/play/artists" class="inline-form">
            <input
              id="artist-q"
              name="q"
              type="search"
              autocomplete="off"
              placeholder="Artist name"
              aria-labelledby="artist-title"
              required
            />
            <PillButton type="submit">Search</PillButton>
          </form>
          <p class="hint">
            One artist's top tracks, or two artists blended into one game.
          </p>
        </section>
        <p class="meta">
          Charts come from Deezer and Apple Music. Previews play from Deezer, or
          from Apple Music when Deezer has none, and each reveal links to the
          track.
        </p>
      </>
    ),
  });
}

export const quitIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);
const flameIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z" />
  </svg>
);
export const checkIcon = (
  <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);
export const flagIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z" />
  </svg>
);

export const crossIcon = (
  <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

function streakOf(results: Game["results"]) {
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i].correct; i--)
    streak += 1;
  return streak;
}

function bestStreak(results: Game["results"]) {
  let best = 0;
  let run = 0;
  for (const result of results) {
    run = result.correct ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

// The game's own top bar, shown in place of the site header while a game
// runs: a way out, the segmented progress through the rounds, then the
// streak and the score. Client scripts update it by id as rounds land.
export function gameBar({
  done,
  total,
  score,
  streak,
  quit = "/",
  current = true,
}: {
  done: number;
  total: number;
  score: number;
  streak: number;
  quit?: string;
  current?: boolean;
}) {
  const round = current ? Math.min(done + 1, total) : Math.max(done, 1);
  return (
    <div class="game-bar">
      <a class="game-quit" href={quit} aria-label="Leave the game">
        {quitIcon}
      </a>
      <ol
        class="game-progress"
        role="progressbar"
        aria-label={`Round ${round} of ${total}`}
        aria-valuenow={round}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        {Array.from({ length: total }, (_, i) => (
          <li
            key={i}
            class={`seg${i < done ? " is-done" : ""}${current && i === done ? " is-current" : ""}`}
          />
        ))}
      </ol>
      <div class="game-side">
        <span class="game-streak" hidden={streak < 2}>
          {flameIcon}
          <span class="game-streak-n">{streak}</span>
        </span>
        <span class="game-score">
          <span class="game-score-n">{score.toLocaleString("en-US")}</span>
        </span>
      </div>
    </div>
  );
}

// The quit confirmation, shared by every game screen: one small dialog with
// one primary and one quiet action. The quit control is a plain link, so a
// no-JS page still leaves; the script opens the dialog instead.
export function quitDialog(back: string = "/") {
  return (
    <dialog class="quit-dialog" id="quit-dialog" aria-labelledby="quit-title">
      <h2 id="quit-title">Leave the game?</h2>
      <p class="meta">Your progress in this game is lost.</p>
      <form method="dialog" class="quit-actions">
        <a class="pill ghost" href={back}>
          Quit
        </a>
        <button class="pill primary" type="submit" autofocus>
          Keep playing
        </button>
      </form>
    </dialog>
  );
}

function reportForm(result: RoundResult, categorySlug: string, back: string) {
  return (
    <details class="report sheet-report">
      <summary aria-label="Report this clip">
        <span class="report-flag">{flagIcon}</span>
        <span class="report-label">Report this clip</span>
      </summary>
      <form class="report-form" method="post" action="/play/report" data-solo>
        <input type="hidden" name="track" value={result.trackKey} />
        <input type="hidden" name="title" value={result.title} />
        <input type="hidden" name="artist" value={result.artist} />
        <input type="hidden" name="category" value={categorySlug} />
        <input type="hidden" name="back" value={back} />
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
  );
}

// The cover's tile always holds its space, so the artwork never pops the
// sheet open late: a neutral square behind the image.
export function coverTile(src: string | null, size = 56) {
  return (
    <span class="cover-tile" style={`width:${size}px;height:${size}px`}>
      {src && <img src={src} alt="" width={size} height={size} />}
    </span>
  );
}

// room.js and screen.js build the same label for their choices.
function choiceLabel({ title, artist }: Choice) {
  return (
    <span class="choice-label">
      <span class="choice-title">{title}</span>
      {artist && <span class="choice-artist">{artist}</span>}
    </span>
  );
}

export function questionPage(
  game: Game,
  preview: Preview,
  choices: Choice[],
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
    chrome: "game",
    children: (
      <div id="game">
        {gameBar({
          done: game.results.length,
          total: roundsPerGame,
          score: game.total,
          streak: streakOf(game.results),
        })}
        <div
          id="round"
          data-phase="question"
          data-src={preview.url}
          data-game={game.id}
          data-remaining={String(remaining)}
          aria-live="polite"
        >
          <div class="page-head">
            <h1>Which song is this?</h1>
          </div>
          <ClipPlayer
            src={preview.url}
            audioId="clip"
            toggleId="clip-toggle"
            barId="count-bar"
            leftId="count-left"
            volumeId="clip-volume"
          />
          {game.mode !== "hard" ? (
            <form
              id="answer-form"
              class="choices"
              method="post"
              action={action}
              data-solo
            >
              {choices.map((choice, index) => (
                <button
                  class="choice"
                  type="submit"
                  name="choice"
                  value={choice.title}
                >
                  <span class="choice-key" aria-hidden="true">
                    {index + 1}
                  </span>
                  {choiceLabel(choice)}
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
        {quitDialog()}
        <noscript>
          <p class="meta">
            This game needs JavaScript: the clip and the timer run through it.
          </p>
        </noscript>
        <script src="/solo.js" defer />
      </div>
    ),
  });
}

const linkService = (link: string) =>
  link.includes("apple.com") ? "Apple Music" : "Deezer";

// A romanized title keeps its own script beside the artist.
const byline = (result: { original?: string; artist: string }) =>
  result.original ? `${result.original} · ${result.artist}` : result.artist;

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
  const streak = streakOf(game.results);
  const choiceState = (title: string) =>
    `choice ${title === result.title ? "is-right" : !result.correct && title === result.answer ? "is-wrong" : ""}`;
  return Page({
    title: `${heading} · ${game.categoryName}`,
    user,
    chrome: "game",
    children: (
      <div id="game">
        {gameBar({
          done: game.results.length,
          total: roundsPerGame,
          score: game.total,
          streak,
          current: false,
        })}
        <div
          id="round"
          data-phase="reveal"
          data-game={game.id}
          data-correct={result.correct ? "1" : ""}
          data-last={last ? "1" : ""}
          data-score={String(result.score)}
          aria-live="polite"
        >
          {result.choices.length > 0 ? (
            <div class="choices reveal-choices">
              {result.choices.map((choice, index) => (
                <button
                  class={choiceState(choice.title)}
                  type="button"
                  disabled
                >
                  {choice.title === result.title ? (
                    checkIcon
                  ) : !result.correct && choice.title === result.answer ? (
                    crossIcon
                  ) : (
                    <span class="choice-key" aria-hidden="true">
                      {index + 1}
                    </span>
                  )}
                  {choiceLabel(choice)}
                  {choice.title === result.title && result.correct && (
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
            </dl>
          )}
          <div
            class={`sheet ${result.correct ? "is-good" : "is-bad"}`}
            id="sheet"
          >
            <div class="sheet-in">
              <div class="sheet-verdict">
                {result.correct ? checkIcon : crossIcon}
                <b>{heading}</b>
                <span
                  class={`sheet-points${result.score > 0 ? "" : " is-none"}`}
                  data-points={result.score}
                >
                  +{result.score}
                </span>
              </div>
              <div class="sheet-song">
                {coverTile(result.cover)}
                <div class="track">
                  <b>{result.title}</b>
                  <small class="muted">{byline(result)}</small>
                  {result.link && (
                    <a href={result.link}>
                      Listen on {linkService(result.link)}
                    </a>
                  )}
                </div>
                {reportForm(result, game.categorySlug, `/play/${game.id}`)}
              </div>
              <form
                class="sheet-next"
                method="post"
                action={`/play/${game.id}/next`}
                data-solo
              >
                <PillButton
                  variant="primary"
                  type="submit"
                  id="continue-button"
                >
                  Continue
                </PillButton>
              </form>
            </div>
          </div>
        </div>
        {quitDialog()}
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
            <a href="/">Guess the song</a>
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
  const fastest = game.results
    .filter((result) => result.correct)
    .reduce((best, result) => Math.min(best, result.elapsedMs), Infinity);
  return Page({
    title: `Game over · ${game.categoryName}`,
    user,
    chrome: "game",
    children: (
      <div id="game">
        {gameBar({
          done: game.results.length,
          total: roundsPerGame,
          score: game.total,
          streak: 0,
          current: false,
        })}
        <div id="round" data-phase="done" aria-live="polite">
          <div class="page-head">
            <h1>Game over</h1>
          </div>
          <Stats
            items={[
              { label: "Score", value: game.total.toLocaleString("en-US") },
              {
                label: "Correct",
                value: `${correct} of ${game.results.length}`,
              },
              { label: "Best streak", value: bestStreak(game.results) },
              {
                label: "Fastest answer",
                value:
                  fastest === Infinity
                    ? "—"
                    : `${(fastest / 1000).toFixed(1)} s`,
              },
            ]}
          />
          <p>
            <PillLink href="/" variant="primary" large>
              Play again
            </PillLink>
          </p>
          <div class="duo">
            <Section title="Rounds">
              <ul class="rows">
                {game.results.map((result) => (
                  <li>
                    <div class="track">
                      <b>{result.title}</b>
                      <small>
                        {byline(result)}
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
        </div>
        <script src="/solo.js" defer />
      </div>
    ),
  });
}

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

const boardNames: Record<BoardPeriod, string> = {
  week: "This week",
  all: "All time",
};

export function categoryBoardPage(
  category: Category,
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
  categories: Category[] = [],
) {
  return Page({
    title: `${category.name} scores · Guess the song`,
    user,
    nav: "board",
    children: (
      <>
        <div class="page-head">
          <a class="back" href="/play/board">
            Points board
          </a>
          <h1>{category.name}</h1>
          <p class="meta">
            Each player's best game in this category over the last{" "}
            {categoryBoardDays} days.
          </p>
        </div>
        {categoryLinks(categories, category.slug)}
        <CategoryBoard entries={entries} />
      </>
    ),
  });
}

function categoryLinks(categories: Category[], current: string | null) {
  return (
    <nav class="chips" aria-label="Scores by category">
      {categories
        .filter((category) => category.feed !== "mine")
        .map((category) => (
          <a
            class="chip"
            href={`/play/board?category=${category.slug}`}
            aria-current={category.slug === current ? "page" : undefined}
          >
            {category.name}
          </a>
        ))}
    </nav>
  );
}

export function boardPage(
  entries: BoardEntry[],
  period: BoardPeriod,
  user: SignedInUser | null,
  categories: Category[] = [],
) {
  return Page({
    title: "Points board · Guess the song",
    user,
    nav: "board",
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
            action={{ href: "/", label: "Play a game" }}
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
        {categories.length > 0 && (
          <Section title="By category" aside={`Last ${categoryBoardDays} days`}>
            {categoryLinks(categories, null)}
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
                <input type="hidden" name="mode" value={defaultMode} />
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
        action={{ href: "/", label: "Back to categories" }}
        heading="h1"
      />
    ),
  });
}
