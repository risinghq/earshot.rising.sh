import type { Child } from "hono/jsx";
import { ScriptTag } from "../ui/assets";
import { PillButton, PillLink } from "../ui/pill";
import { Section } from "../ui/section";
import { Segmented } from "../ui/segmented";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import { EmptyState, SaveScoreCard } from "../ui/empty";
import { BackLink, Monogram, Mosaic, playIcon, soundMark } from "../ui/person";
import type { ArtistProfile, Category } from "./catalog";
import { forYouSlug } from "./foryou";
import { tileCovers, type TileFacts } from "./hub";
import { eraLabel, eraName, erasCount, isGeneration } from "./eras";
import type { Game, RoundResult } from "./game";
import type { BoardEntry, BoardPeriod, CategoryBoardEntry } from "./results";
import { categoryBoardDays, categoryBoardSize } from "./results";
import { roundSeconds, roundsPerGame } from "./game";
import { matchWaitMs } from "./room";
import {
  byline,
  defaultMode,
  linkService,
  modeNames,
  modes,
  type Choice,
  type Mode,
} from "./rules";
import { providerHref, type SignedInUser } from "../auth";
import type { ArtistHit, Candidate, Preview } from "./sources";

const modeHints: Record<Mode, string> = {
  easy: "Song + artist",
  normal: "Title only",
  hard: "Type it",
};

const profileHref = (name: string) => `/u/${encodeURIComponent(name)}`;
const number = (value: number) => value.toLocaleString("en-US");
const winsText = (wins: number) => `${wins} ${wins === 1 ? "win" : "wins"}`;

// Days are counted in UTC, like every other date on the site.
function daysAgo(finishedAt: number, now: number) {
  const days = Math.floor(now / 86400) - Math.floor(finishedAt / 86400);
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function Tally({ correct, rounds }: { correct: number; rounds: number }) {
  return (
    <>
      <span
        class="pips"
        role="img"
        aria-label={`${correct} of ${rounds} right`}
      >
        {Array.from({ length: rounds }, (_, index) => (
          <i class={index < correct ? "on" : undefined} />
        ))}
      </span>
      <span aria-hidden="true">
        {correct}/{rounds}
      </span>
    </>
  );
}

export function CategoryBoard({
  entries,
  you = null,
  now = Date.now() / 1000,
}: {
  entries: CategoryBoardEntry[];
  you?: string | null;
  now?: number;
}) {
  if (entries.length === 0)
    return <p class="hint">No scores in the last {categoryBoardDays} days.</p>;
  return (
    <div class="list-card is-genre">
      <div class="lhead" aria-hidden="true">
        <span>#</span>
        <span>Player</span>
        <span>Correct</span>
        <span>When</span>
        <span class="end">Score</span>
      </div>
      <ol>
        {entries.map((entry, index) => {
          const when =
            entry.finished_at === undefined
              ? null
              : daysAgo(entry.finished_at, now);
          const tally =
            entry.correct == null || !entry.rounds ? null : (
              <Tally correct={entry.correct} rounds={entry.rounds} />
            );
          return (
            <li class={entry.name === you ? "lrow is-you" : "lrow"}>
              <span class="rank">{index + 1}</span>
              <a class="who" href={profileHref(entry.name)}>
                <Monogram name={entry.name} />
                <span class="who-text">
                  <span class="name">{entry.name}</span>
                  {when && <span class="sub is-narrow">{when}</span>}
                </span>
              </a>
              <span class="col tally is-wide">{tally}</span>
              <span class="col is-wide">{when}</span>
              <span class="score-col">
                <b class="points">{number(entry.score)}</b>
                {tally && <span class="tally is-narrow">{tally}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export type PlayWho = "solo" | "room";

const whoActions: Record<PlayWho, string> = {
  solo: "/play",
  room: "/play/room",
};
// The hub offers the two shown modes; ?mode=hard still reaches the tiles.
const hubModes = ["easy", "normal"] as const satisfies readonly Mode[];
// A room tile carries the creator's token, which the room client keeps in
// localStorage; the room refuses a switch without it. The token is filled on
// submit because this script runs before the tiles are parsed.
const setupScript = `
const setup = document.getElementById("play-setup");
const actions = { solo: "/play", room: "/play/room" };
setup.addEventListener("change", () => {
  const who = setup.querySelector('input[name="who"]:checked')?.value;
  const mode = setup.querySelector('input[name="mode"]:checked').value;
  document.querySelectorAll("form.tile").forEach((tile) => {
    if (who && !tile.hasAttribute("data-solo") && !tile.hasAttribute("data-room"))
      tile.action = actions[who];
    tile.querySelector('input[name="mode"]').value = mode;
  });
});
document.addEventListener("submit", (event) => {
  const tile = event.target;
  if (!tile.matches("form.tile[data-room]")) return;
  tile.querySelector('input[name="k"]').value =
    localStorage.getItem("quiz-room-" + tile.dataset.room) ?? "";
});
`;

// Four covers make a mosaic; fewer show the first one whole, and none shows
// the mark on a tint.
function genreArt(covers: string[]) {
  if (covers.length === 0)
    return <span class="genre-art is-blank">{soundMark}</span>;
  const shown = covers.length >= tileCovers ? covers : covers.slice(0, 1);
  return (
    <span class={shown.length === 1 ? "genre-art is-single" : "genre-art"}>
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

// A tile starts a game for the chosen "who", or, on the hub opened from a
// room (`/?room=CODE`), sets that room's next category.
type TileTarget = { who: PlayWho } | { room: string };

// Every form.tile follows the setup choices through setupScript.
function tileForm(
  category: Category,
  target: TileTarget,
  mode: Mode,
  body: Child,
) {
  const room = "room" in target ? target.room : null;
  return (
    <form
      class="tile"
      key={category.slug}
      method="post"
      action={
        room === null
          ? whoActions[(target as { who: PlayWho }).who]
          : `/play/room/${room}/switch`
      }
      {...(room === null ? {} : { "data-room": room })}
    >
      <input type="hidden" name="category" value={category.slug} />
      <input type="hidden" name="mode" value={mode} />
      {room !== null && <input type="hidden" name="k" value="" />}
      {body}
    </form>
  );
}

// A genre row starts a game on the whole pool from its art or All; a decade
// chip narrows it. The art repeats All for a larger target, so it stays out of
// the tab order and the accessibility tree.
function genreRow(
  category: Category,
  facts: TileFacts,
  target: TileTarget,
  mode: Mode,
) {
  const by = facts.eras.some(isGeneration) ? "generation" : "decade";
  return tileForm(
    category,
    target,
    mode,
    <>
      <button
        class="genre-art-button"
        type="submit"
        tabindex={-1}
        aria-hidden="true"
      >
        {genreArt(facts.covers)}
      </button>
      <div class="genre-body">
        <p class="genre-title">
          <b>{category.name}</b>
          {facts.eras.length > 1 && <span>{erasCount(facts.eras)}</span>}
        </p>
        <div
          class="genre-chips"
          data-kind={by === "generation" ? "gen" : undefined}
          role="group"
          aria-label={`${category.name} by ${by}`}
        >
          <button
            class="chip is-all"
            type="submit"
            aria-label={`${category.name}, every ${by}`}
          >
            All
          </button>
          {facts.eras.map((era) => (
            <button
              class="chip"
              type="submit"
              name="era"
              value={era}
              aria-label={`${category.name}, ${eraName(era)}`}
            >
              {eraLabel(era)}
            </button>
          ))}
        </div>
      </div>
    </>,
  );
}

const chartLabel = (category: Category) =>
  category.name.replace(/^Top 50 /, "");

function chartChip(
  category: Category,
  target: TileTarget,
  mode: Mode,
  user: SignedInUser | null,
) {
  if (category.feed === "mine" && user === null)
    return (
      <a class="chip is-quiet" href="/auth/github" key={category.slug}>
        {category.name}
      </a>
    );
  return tileForm(
    category,
    target,
    mode,
    <button
      class={category.feed === "mine" ? "chip is-quiet" : "chip"}
      type="submit"
    >
      {chartLabel(category)}
    </button>,
  );
}

// The For you card is a solo game on every "who" choice, so the setup script
// leaves its action alone.
function forYouCard(mode: Mode, cold: boolean) {
  return (
    <form class="tile for-you" method="post" action="/play" data-solo>
      <input type="hidden" name="category" value={forYouSlug} />
      <input type="hidden" name="mode" value={mode} />
      <button type="submit">
        <span class="for-you-text">
          <span class="label">For you</span>
          <span class="for-you-name">Your mix</span>
          <span class="for-you-note">
            {cold
              ? "Learns your taste as you play."
              : "Tracks you know, plus new ones."}
          </span>
        </span>
        <span class="for-you-play">
          {playIcon}
          <span>Play mix</span>
        </span>
      </button>
    </form>
  );
}

// Charts and the player's own plays sit apart from the genres: they have no
// decades and change every week.
const isChart = (category: Category) =>
  category.feed === "mine" || category.slug.startsWith("top-50-");
// Global leads the charts and the player's own plays close them; the
// country charts keep the catalog's order between.
const chartRank = (category: Category) =>
  category.slug === "top-50-global" ? 0 : category.feed === "mine" ? 2 : 1;
const byChartOrder = (a: Category, b: Category) => chartRank(a) - chartRank(b);

export interface HubOptions {
  categories: Category[];
  facts: Record<string, TileFacts>;
  user: SignedInUser | null;
  who?: PlayWho;
  mode?: Mode;
  forYouColdStart?: boolean;
  // A room code: the hub picks that room's next category.
  room?: string;
}

export function hubPage({
  categories,
  facts,
  user,
  who = "solo",
  mode = defaultMode,
  forYouColdStart = true,
  room,
}: HubOptions) {
  const whoChecked = (value: PlayWho) =>
    who === value ? { checked: true } : {};
  const target: TileTarget = room === undefined ? { who } : { room };
  const genres = categories.filter((category) => !isChart(category));
  const charts = categories.filter(isChart).sort(byChartOrder);
  return Page({
    title: room === undefined ? "Guess the song" : "Next category",
    user,
    nav: "play",
    bodyClass: "hub",
    children: (
      <>
        <div class="hub-hero">
          <div class="hub-intro">
            {room === undefined ? (
              <>
                <h1 class="display">Guess the song.</h1>
                <p class="lede">
                  Ten clips, {roundSeconds} seconds each. The faster you’re
                  right, the more you score.
                </p>
              </>
            ) : (
              <>
                <h1 class="display">Next category.</h1>
                <p class="lede">
                  Pick what room {room} plays next. Everyone stays in the room.{" "}
                  <a href={`/play/room/${room}`}>Back to the room</a>
                </p>
              </>
            )}
            <form class="play-setup" id="play-setup" method="get" action="/">
              {room !== undefined && (
                <input type="hidden" name="room" value={room} />
              )}
              <fieldset class="setup-row" hidden={room !== undefined}>
                <legend class="label">Play</legend>
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
                    Room
                  </label>
                </div>
              </fieldset>
              <fieldset class="setup-row">
                <legend class="label">Show</legend>
                <div class="segmented">
                  {hubModes.map((value) => (
                    <label>
                      <input
                        type="radio"
                        name="mode"
                        value={value}
                        {...(mode === value ? { checked: true } : {})}
                      />
                      {modeHints[value]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <noscript>
                <button class="pill" type="submit">
                  Apply
                </button>
              </noscript>
            </form>
            <script dangerouslySetInnerHTML={{ __html: setupScript }} />
          </div>
          {room === undefined && forYouCard(mode, forYouColdStart)}
        </div>
        <div class="hub-lists">
          <section class="hub-section" aria-labelledby="genres-title">
            <div class="hub-section-head">
              <h2 id="genres-title">Genres</h2>
              <p>
                <span class="is-narrow">Tap an era</span>
                <span class="is-wide">Pick an era, or All</span>
              </p>
            </div>
            <div class="genres">
              {genres.map((category) =>
                genreRow(
                  category,
                  facts[category.slug] ?? { eras: [], covers: [] },
                  target,
                  mode,
                ),
              )}
              <p class="genre-more">
                <span class="genre-art" aria-hidden="true" />
                More genres coming
              </p>
            </div>
          </section>
          <section class="hub-section" aria-labelledby="ways-title">
            <div class="hub-section-head">
              <h2 id="ways-title">More ways to play</h2>
            </div>
            <div class="ways">
              {charts.length > 0 && (
                <div class="way">
                  <h3>Top 50 charts</h3>
                  <div class="chips">
                    {charts.map((category) =>
                      chartChip(category, target, mode, user),
                    )}
                  </div>
                </div>
              )}
              <div class="way" hidden={room !== undefined}>
                <h3 id="artist-title">Play an artist</h3>
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
                  <button class="pill ink" type="submit">
                    Search
                  </button>
                </form>
                <p class="hint">One artist, or blend two into one game.</p>
              </div>
            </div>
          </section>
        </div>
        <p class="meta hub-note">
          Clips and charts from Deezer, with Apple Music as fallback. Every
          reveal links to the track.
        </p>
      </>
    ),
  });
}

const quitIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);
const trophyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4h10v3h3v2a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V7h3zm0 5V9H6a2 2 0 0 0 1 1.7zm10 0v1.7A2 2 0 0 0 18 9z" />
  </svg>
);
const checkIcon = (
  <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);
const flagIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z" />
  </svg>
);

const crossIcon = (
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
// streak and the score. Client scripts update it by id as rounds land. A
// finished round's segment turns right or wrong when marks says which. A
// room passes its mode, which takes the streak's place.
function gameBar({
  done,
  marks = [],
  total,
  score,
  streak,
  quit = "/",
  current = true,
  mode,
  tools,
}: {
  done: number;
  marks?: boolean[];
  total: number;
  score: number;
  streak: number;
  quit?: string;
  current?: boolean;
  mode?: string;
  // Controls that sit beside the quit button, such as the room's Devices.
  tools?: Child;
}) {
  const round = current ? Math.min(done + 1, total) : Math.max(done, 1);
  return (
    <div class="game-bar">
      <a class="game-quit" href={quit} aria-label="Leave the game">
        {quitIcon}
      </a>
      {tools}
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
            class={`seg${i < done ? " is-done" : ""}${i < marks.length ? (marks[i] ? " is-right" : " is-wrong") : ""}${current && i === done ? " is-current" : ""}`}
          />
        ))}
      </ol>
      <div class="game-side">
        {mode === undefined ? (
          <span class="game-streak" hidden={streak < 2}>
            Streak ×<span class="game-streak-n">{streak}</span>
          </span>
        ) : (
          <span class="room-mode">{mode}</span>
        )}
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

// The song a reveal shows. client/room/NowPlaying.tsx draws the same card.
type ShownSong = Pick<
  RoundResult,
  "trackKey" | "title" | "original" | "artist" | "cover" | "link"
>;

function reportForm(result: ShownSong, categorySlug: string, back: string) {
  return (
    <details class="report sheet-report">
      <summary aria-label="Report this clip">
        <span class="report-flag">{flagIcon}</span>
        <span class="report-label">Report</span>
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

const outIcon = (
  <svg viewBox="0 0 24 24" class="out-icon" aria-hidden="true">
    <path d="M8 16L16 8M9 8h7v7" />
  </svg>
);

// The answered song, shown on the clip's own stage while the clip plays on.
// solo.js moves this block into the question's player, so the
// audio and its pause button survive the reveal.
function nowPlaying(result: ShownSong, categorySlug: string, back: string) {
  return (
    <div class="now">
      <p class="now-label">
        <span class="now-eq" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        Now playing
      </p>
      <span class="cover-tile now-cover">
        {result.cover && (
          <img src={result.cover} alt="" width={320} height={320} />
        )}
      </span>
      <div class="now-song">
        <b class="now-title">{result.title}</b>
        <span class="now-by">{byline(result)}</span>
      </div>
      <div class="now-links">
        {result.link && (
          <a class="now-link" href={result.link}>
            <span class="now-link-long">Listen on</span>
            {linkService(result.link)}
            {outIcon}
          </a>
        )}
        {reportForm(result, categorySlug, back)}
      </div>
    </div>
  );
}

// client/room/parts.tsx and screen.js build the same label for their
// choices.
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
          marks: game.results.map((result) => result.correct),
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
          <p class="label round-count">
            Round {game.results.length + 1} of {roundsPerGame}
          </p>
          <ClipPlayer
            src={preview.url}
            label={game.categoryName}
            audioId="clip"
            toggleId="clip-toggle"
            barId="count-bar"
            leftId="count-left"
            worthId="count-worth"
            volumeId="clip-volume"
            timerWaits
            round={`Round ${game.results.length + 1} of ${roundsPerGame}`}
          />
          <h1 class="round-title">Which song is this?</h1>
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
              <div class="form-row">
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
          {game.mode !== "hard" && (
            <p class="round-keys" aria-hidden="true">
              <kbd>1–4</kbd> answer <kbd>Space</kbd> pause
            </p>
          )}
        </div>
        {quitDialog()}
        <noscript>
          <p class="meta">
            This game needs JavaScript: the clip and the timer run through it.
          </p>
        </noscript>
        <ScriptTag name="solo" />
      </div>
    ),
  });
}

function revealPage(
  game: Game,
  result: RoundResult,
  user: SignedInUser | null,
) {
  const heading = result.correct
    ? "Nailed it!"
    : result.timedOut
      ? "Time ran out"
      : "Not quite";
  const last = game.results.length >= roundsPerGame;
  const streak = streakOf(game.results);
  const lostStreak = result.correct ? 0 : streakOf(game.results.slice(0, -1));
  const seconds = (result.elapsedMs / 1000).toFixed(1);
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
          marks: game.results.map((result) => result.correct),
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
          <p class="label round-count">
            Round {game.results.length} of {roundsPerGame}
          </p>
          <div class="player is-reveal">
            {nowPlaying(result, game.categorySlug, `/play/${game.id}`)}
          </div>
          <h1 class="round-title">Which song is this?</h1>
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
                  {choice.title === result.answer && (
                    <span class="choice-you">
                      You<span class="is-wide">r pick</span>
                    </span>
                  )}
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
              <b class="sheet-heading">{heading}</b>
              <span
                class={`sheet-points${result.score > 0 ? "" : " is-none"}`}
                data-points={result.score}
              >
                +{result.score}
              </span>
              {result.correct ? (
                <p class="sheet-sub">
                  {streak >= 2 && (
                    <span class="sheet-streak">Streak ×{streak}</span>
                  )}
                  <span>
                    <span class="is-wide">Answered </span>in {seconds} s
                    {streak >= 2 && (
                      <span class="is-wide"> · {streak} in a row</span>
                    )}
                  </span>
                </p>
              ) : (
                lostStreak >= 2 && (
                  <p class="sheet-sub">Streak reset · you had {lostStreak}</p>
                )
              )}
              <form
                class="sheet-next"
                method="post"
                action={`/play/${game.id}/next`}
                data-solo
              >
                <PillButton
                  variant="primary"
                  large
                  type="submit"
                  id="continue-button"
                >
                  Continue
                  <kbd class="sheet-kbd" aria-hidden="true">
                    Enter
                  </kbd>
                </PillButton>
              </form>
            </div>
          </div>
        </div>
        {quitDialog()}
        <ScriptTag name="solo" />
      </div>
    ),
  });
}

type Picked = { id: number; name: string } | null;

const searchIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle
      cx="7.5"
      cy="7.5"
      r="5.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
    <path
      d="M11.5 11.5L16 16"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    />
  </svg>
);

function searchHref(query: string, picked: Picked) {
  const params = new URLSearchParams({ q: query });
  if (picked !== null) {
    params.set("with", String(picked.id));
    params.set("n", picked.name);
  }
  return `/play/artists?${params}`;
}

// While blending, a hit opens the blend with the artist already picked; the
// picked artist itself, or any hit outside a blend, opens its own page.
function hitHref(hit: ArtistHit, picked: Picked) {
  return picked === null || picked.id === hit.id
    ? `/play/artist/${hit.id}`
    : `/play/artist/${picked.id}-${hit.id}`;
}

function artistArt(hit: ArtistHit, className: string, size: number) {
  return hit.picture === null ? (
    <span class={`${className} is-empty`} aria-hidden="true">
      {hit.name.slice(0, 1)}
    </span>
  ) : (
    <img
      class={className}
      src={hit.picture}
      alt=""
      width={size}
      height={size}
      loading="lazy"
    />
  );
}

function topHit(hit: ArtistHit, picked: Picked, query: string) {
  const blending = picked !== null && picked.id !== hit.id;
  return (
    <div class="artist-top-card">
      {artistArt(hit, "artist-top-art", 250)}
      <div class="artist-top-body">
        <b>{hit.name}</b>
        <p class="meta">
          {number(hit.fans)} fans · {roundsPerGame} rounds of top tracks
        </p>
        <div class="artist-top-actions">
          <a class="btn is-primary" href={hitHref(hit, picked)}>
            {blending ? `Blend with ${picked.name} →` : `Open ${hit.name} →`}
          </a>
          {blending ? (
            <a href={`/play/artist/${hit.id}`}>Play {hit.name} alone</a>
          ) : (
            picked === null && (
              <a
                href={`/play/artists?${new URLSearchParams({ q: query, with: String(hit.id), n: hit.name })}`}
              >
                Blend with another artist
              </a>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function hitRow(hit: ArtistHit, picked: Picked) {
  return (
    <li key={hit.id}>
      <a href={hitHref(hit, picked)}>
        {artistArt(hit, "artist-hit-art", 56)}
        <span class="artist-hit-name">
          <b>{hit.name}</b>
          <small>{number(hit.fans)} fans</small>
        </span>
        <span class="artist-hit-go" aria-hidden="true">
          ›
        </span>
      </a>
    </li>
  );
}

// `results` is null when the search itself failed, so the page can offer the
// genres instead of a dead end.
export function artistsPage(
  query: string,
  results: ArtistHit[] | null,
  picked: Picked,
  genres: { slug: string; name: string }[],
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
          {picked !== null && (
            <p class="meta">
              Blending with {picked.name}. Pick the second artist, or{" "}
              <a href={`/play/artists?${new URLSearchParams({ q: query })}`}>
                start over
              </a>
              .
            </p>
          )}
        </div>
        <form method="get" action="/play/artists" class="artist-search">
          {picked !== null && (
            <>
              <input type="hidden" name="with" value={picked.id} />
              <input type="hidden" name="n" value={picked.name} />
            </>
          )}
          <label>
            {searchIcon}
            <span class="sr-only">
              {picked === null ? "Artist" : "Second artist"}
            </span>
            <input
              name="q"
              type="search"
              autocomplete="off"
              placeholder="Search any artist"
              value={query}
              required
              {...(query === "" ? { autofocus: true } : {})}
            />
          </label>
        </form>
        {results === null ? (
          <div class="artist-search-down" role="alert">
            <h2>Search is down, try a genre</h2>
            <p>Deezer isn't answering. Genres still work.</p>
            <a class="btn" href={searchHref(query, picked)}>
              Try again
            </a>
          </div>
        ) : query !== "" && results.length === 0 ? (
          <div class="artist-search-empty">
            <h2>No artist called “{query}”</h2>
            <p class="meta">Check the spelling, or play a genre instead.</p>
          </div>
        ) : null}
        {results !== null && results.length > 0 && (
          <div class="artist-results">
            <section class="artist-top" aria-labelledby="top-hit">
              <h2 class="label" id="top-hit">
                Top hit
              </h2>
              {topHit(results[0], picked, query)}
            </section>
            {results.length > 1 && (
              <section class="artist-others" aria-labelledby="others">
                <div class="section-head">
                  <h2 class="label" id="others">
                    Did you mean
                  </h2>
                  <small class="label">{results.length} on Deezer</small>
                </div>
                <ul class="artist-hits">
                  {results.slice(1, 7).map((hit) => hitRow(hit, picked))}
                </ul>
                {results.length > 7 && (
                  <details>
                    <summary>Show all {results.length}</summary>
                    <ul class="artist-hits">
                      {results.slice(7).map((hit) => hitRow(hit, picked))}
                    </ul>
                  </details>
                )}
              </section>
            )}
          </div>
        )}
        {(results === null || (query !== "" && results.length === 0)) && (
          <section class="artist-genres" aria-labelledby="genres">
            <h2 class="label" id="genres">
              Genres
            </h2>
            <form class="chips" method="post" action="/play">
              <input type="hidden" name="mode" value={defaultMode} />
              {genres.map((genre) => (
                <button
                  class="chip"
                  type="submit"
                  name="category"
                  value={genre.slug}
                >
                  {genre.name}
                </button>
              ))}
              <a class="chip" href="/">
                All genres →
              </a>
            </form>
          </section>
        )}
        <p class="meta">
          Artist names, pictures and fan counts come from Deezer. Each reveal
          links to the track on Deezer.
        </p>
      </>
    ),
  });
}

const modeHelp: Record<Mode, string> = {
  easy: "Pick from 4 choices, artist names shown",
  normal: "Pick the title from 4 choices",
  hard: "Type the title",
};

// One form, three submit buttons: CSS shows the one the Who choice names, so
// the page posts to the solo, room or match endpoint without a script.
function startCard(category: Category, user: SignedInUser | null) {
  const who = [
    {
      value: "solo",
      label: "Solo",
      action: "/play",
      go: "Play solo",
      note:
        user === null
          ? `Sign in and your score goes on the ${category.name} board.`
          : `Your score goes on the ${category.name} board.`,
    },
    {
      value: "room",
      label: "With friends",
      action: "/play/room",
      go: "Create a room",
      note: "You get a 6-letter code to share. Switch artists or genres later without a new room.",
    },
    {
      value: "match",
      label: "Random",
      action: "/play/match",
      go: "Find an opponent",
      note: `Waits up to ${matchWaitMs / 1000} s for another player on ${category.name}, then starts.`,
    },
  ];
  return (
    <form class="start-card" method="post" action="/play">
      <h2>Start a game</h2>
      <input type="hidden" name="category" value={category.slug} />
      <fieldset class="start-row">
        <legend class="label">Who</legend>
        <div class="segmented">
          {who.map((option) => (
            <label>
              <input
                type="radio"
                name="who"
                value={option.value}
                {...(option.value === "solo" ? { checked: true } : {})}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset class="start-row start-mode">
        <legend class="label">Mode</legend>
        <div class="segmented">
          {modes.map((mode) => (
            <label>
              <input
                type="radio"
                name="mode"
                value={mode}
                {...(mode === defaultMode ? { checked: true } : {})}
              />
              {modeNames[mode]}
            </label>
          ))}
        </div>
        <p class="hint start-help">
          {modes.map((mode) => (
            <span data-mode={mode}>{modeHelp[mode]}</span>
          ))}
        </p>
      </fieldset>
      {who.map((option) => (
        <div class="start-go" data-who={option.value}>
          <button
            class="btn is-primary is-lg is-block"
            type="submit"
            formaction={option.action}
          >
            <span>
              {option.go}
              {option.value !== "match" &&
                modes.map((mode) => (
                  <span data-mode={mode}> · {modeNames[mode]}</span>
                ))}
            </span>
          </button>
          <p class="hint">{option.note}</p>
        </div>
      ))}
    </form>
  );
}

export function artistPage(
  category: Category,
  profiles: ArtistProfile[],
  songs: Candidate[],
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
) {
  const ids = category.slug.slice("artist-".length).split("-");
  const fans = profiles.reduce((sum, profile) => sum + profile.fans, 0);
  return Page({
    title: `${category.name} · Guess the song`,
    user,
    children: (
      <div class="artist-page">
        <div class="artist-main">
          <p class="meta">
            <a href="/play/artists">Find an artist</a>
          </p>
          <div class="artist-head">
            <div class="artist-photos">
              {profiles.map((profile) =>
                profile.picture === null ? (
                  <span class="artist-photo is-empty" aria-hidden="true">
                    {profile.name.slice(0, 1)}
                  </span>
                ) : (
                  <img
                    class="artist-photo"
                    src={profile.picture}
                    alt=""
                    width="250"
                    height="250"
                  />
                ),
              )}
            </div>
            <div>
              <h1>{category.name}</h1>
              <p class="meta">
                {fans > 0 && `${number(fans)} fans · `}
                {roundsPerGame} rounds, {roundSeconds} s each
              </p>
            </div>
          </div>
          {songs.length > 0 && (
            <section class="artist-songs" aria-labelledby="songs-title">
              <div class="section-head">
                <h2 id="songs-title">In this game</h2>
                <small class="label">From the top tracks</small>
              </div>
              <ul>
                {songs.map((song) => (
                  <li>
                    {song.cover === null ? (
                      <span class="artist-song-art" aria-hidden="true" />
                    ) : (
                      <img
                        class="artist-song-art"
                        src={song.cover}
                        alt=""
                        width="250"
                        height="250"
                        loading="lazy"
                      />
                    )}
                    <b>{song.title}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div class="artist-side">
          {startCard(category, user)}
          {ids.length === 1 && (
            <a
              class="artist-blend"
              href={`/play/artists?with=${ids[0]}&n=${encodeURIComponent(category.name)}`}
            >
              Blend {category.name} with another artist
            </a>
          )}
        </div>
        <div class="artist-board">
          <Section title="Top scores" aside={`Last ${categoryBoardDays} days`}>
            <CategoryBoard entries={entries} />
          </Section>
        </div>
      </div>
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

const bestGameNote = `Each player's best single game, last ${categoryBoardDays} days.`;

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
      <div class="board is-genre">
        <div class="board-main">
          <BackLink href="/play/board" label="Points board" />
          <section class="hero-stage">
            <Mosaic seed={category.slug} />
            <div class="hero-text">
              <p class="kicker">Genre board</p>
              <h1 class="hero-title">{category.name}</h1>
              <p class="hero-sub">{bestGameNote}</p>
            </div>
            <form class="hero-foot" method="post" action="/play">
              <input type="hidden" name="category" value={category.slug} />
              <input type="hidden" name="mode" value={defaultMode} />
              <button class="btn is-primary is-play" type="submit">
                {playIcon}
                Play {category.name}
              </button>
            </form>
          </section>
          <CategoryBoard entries={entries} you={user?.name ?? null} />
        </div>
        <GenreRail
          categories={categories}
          current={category.slug}
          title="Other genres"
        />
      </div>
    ),
  });
}

// The current genre leads the rail, so on a phone it is the first chip in
// the scrolling row.
function GenreRail({
  categories,
  current = null,
  title,
}: {
  categories: Category[];
  current?: string | null;
  title: string;
}) {
  const genres = categories.filter((category) => category.feed !== "mine");
  if (genres.length === 0) return null;
  const ordered =
    current === null
      ? genres
      : [
          ...genres.filter((category) => category.slug === current),
          ...genres.filter((category) => category.slug !== current),
        ];
  return (
    <section
      class={current === null ? "rail" : "rail is-scroll"}
      aria-label="Scores by genre"
    >
      <header>
        <div class="sect-title">
          <h2>{title}</h2>
          {current === null && (
            <span class="aside is-narrow">
              Best game · {categoryBoardDays} days
            </span>
          )}
        </div>
        {current === null && <p class="is-wide">{bestGameNote}</p>}
      </header>
      <nav class="genre-chips">
        {ordered.map((category) => (
          <a
            class="chip-genre"
            href={`/play/board?category=${category.slug}`}
            aria-current={category.slug === current ? "page" : undefined}
          >
            <Mosaic seed={category.slug} />
            <span>{category.name}</span>
          </a>
        ))}
      </nav>
    </section>
  );
}

const podiumShown = 3;
const rowsShown = 12;

function PodiumCard({
  entry,
  place,
  period,
}: {
  entry: BoardEntry;
  place: number;
  period: BoardPeriod;
}) {
  const wins = winsText(entry.wins);
  return (
    <li>
      <span class="rank">
        {place === 1 ? (
          <>
            #1
            <span class="is-wide">
              {" "}
              {period === "week" ? "this week" : "all time"} · {wins}
            </span>
          </>
        ) : (
          <>
            <span class="is-wide">#</span>
            {place}
            <span class="is-wide"> · {wins}</span>
          </>
        )}
      </span>
      <Monogram name={entry.name} />
      <a class="name" href={profileHref(entry.name)}>
        {entry.name}
      </a>
      <span class="points">{number(entry.points)}</span>
      <span class="wins">{wins}</span>
    </li>
  );
}

function BoardRow({
  entry,
  place,
  you,
}: {
  entry: BoardEntry;
  place: number;
  you: string | null;
}) {
  return (
    <li class={entry.name === you ? "lrow is-you" : "lrow"}>
      <span class="rank">{place}</span>
      <a class="who" href={profileHref(entry.name)}>
        <Monogram name={entry.name} />
        <span class="who-text">
          <span class="name">{entry.name}</span>
          <span class="sub is-narrow">{winsText(entry.wins)}</span>
        </span>
      </a>
      <span class="col end is-wide">{entry.wins}</span>
      <span class="points">{number(entry.points)}</span>
    </li>
  );
}

export function boardPage(
  entries: BoardEntry[],
  period: BoardPeriod,
  user: SignedInUser | null,
  categories: Category[] = [],
) {
  const you = user?.name ?? null;
  const rest = entries.slice(podiumShown);
  const shown = rest.slice(0, rowsShown - podiumShown);
  const more = rest.slice(rowsShown - podiumShown);
  return Page({
    title: "Points board · Guess the song",
    user,
    nav: "board",
    children: (
      <div class="board">
        <div class="board-main">
          <header class="head">
            <div>
              <h1>Points board</h1>
              <p class="lead">
                Total points from finished games. The week starts Monday 00:00
                UTC.
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
          </header>
          {entries.length === 0 ? (
            <EmptyState
              title="No scored games yet"
              body="Signed-in players land here when they finish a game. Play one to open the board."
              action={{ href: "/", label: "Play a game" }}
            />
          ) : (
            <>
              <ol class="podium" aria-label="Top three">
                {entries.slice(0, podiumShown).map((entry, index) => (
                  <PodiumCard entry={entry} place={index + 1} period={period} />
                ))}
              </ol>
              {rest.length > 0 && (
                <div class="list-card board-list">
                  <div class="lhead" aria-hidden="true">
                    <span>#</span>
                    <span>Player</span>
                    <span class="end">Wins</span>
                    <span class="end">Points</span>
                  </div>
                  <ol start={podiumShown + 1}>
                    {shown.map((entry, index) => (
                      <BoardRow
                        entry={entry}
                        place={podiumShown + 1 + index}
                        you={you}
                      />
                    ))}
                  </ol>
                  {more.length > 0 && (
                    <details class="list-more">
                      <summary>
                        Show ranks {rowsShown + 1}–{entries.length}
                      </summary>
                      <ol start={rowsShown + 1}>
                        {more.map((entry, index) => (
                          <BoardRow
                            entry={entry}
                            place={rowsShown + 1 + index}
                            you={you}
                          />
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <GenreRail categories={categories} title="Board by genre" />
      </div>
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
    styles: ["common", "site", "game"],
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
              <div class="form-row">
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

        <ScriptTag name="match" />
      </div>
    ),
  });
}

export function feedErrorPage(
  name: string,
  user: SignedInUser | null,
  back = "/",
) {
  return Page({
    title: "Category unavailable",
    user,
    children: (
      <EmptyState
        title={`${name} is not available right now`}
        body="The music feed did not answer. Pick another category or try again in a moment."
        action={{ href: back, label: "Back to categories" }}
        heading="h1"
      />
    ),
  });
}
