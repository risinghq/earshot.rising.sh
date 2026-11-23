import { ScriptTag } from "../ui/assets";
import { PillButton } from "../ui/pill";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import {
  type Game,
  type RoundResult,
  roundSeconds,
  roundsPerGame,
} from "./game";
import { byline, linkService, type Choice } from "./rules";
import { type SignedInUser } from "../auth";
import { type Preview } from "./sources";
import {
  checkIcon,
  crossIcon,
  flagIcon,
  gameBar,
  quitDialog,
  streakOf,
} from "./game-parts";

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

const outIcon = (
  <svg viewBox="0 0 24 24" class="out-icon" aria-hidden="true">
    <path d="M8 16L16 8M9 8h7v7" />
  </svg>
);

// The answered song, shown on the clip's own stage while the clip plays on.
// client/solo.ts moves this block into the question's player, so the
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

// client/room/parts.tsx builds the same label for the room's choices.
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

export function revealPage(
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
