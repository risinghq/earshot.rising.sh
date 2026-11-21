import { providerHref, type SignedInUser } from "../auth";
import { SaveScoreCard, SignInButtons } from "../ui/empty";
import { Mosaic } from "../ui/person";
import { PillButton, PillLink } from "../ui/pill";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import {
  checkIcon,
  crossIcon,
  gameBar,
  nowPlaying,
  quitDialog,
  quitIcon,
} from "./pages";
import { roundsPerGame } from "./quiz";
import { categoryBoardDays } from "./results";

const copyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="3" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);
const shareIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v12M7 8l5-5 5 5M5 14v5h14v-5" />
  </svg>
);
const soundOffIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="is-solid" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);
const tvIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);
const chevronIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// The room page is one shell for every phase. public/room.js shows the panel
// that matches the room's state and fills it. The round uses the solo
// round's parts (game bar, stage, choices, sheet, results), so the two modes
// look and move the same. The stage and its <audio> persist for the whole
// visit: a phone that unlocked sound once keeps it for every round. The
// room's own parts come from the Claude Design file "Earshot Room".
export function roomPage(code: string, user: SignedInUser | null) {
  const back = `/play/room/${code}`;
  return Page({
    title: `Room ${code}`,
    user,
    chrome: "game",
    children: (
      <div
        id="game"
        class="room"
        data-code={code}
        data-user={user ? "1" : undefined}
        data-phase="connecting"
      >
        {gameBar({
          done: 0,
          total: roundsPerGame,
          score: 0,
          streak: 0,
          mode: "",
        })}
        <div class="results-head">
          <a class="results-quit" href="/" aria-label="Leave the room">
            {quitIcon}
          </a>
          <b id="room-name">Room {code}</b>
        </div>
        <noscript>
          <p class="meta">
            This room needs JavaScript: it plays over a live connection.
          </p>
        </noscript>
        <p class="form-error room-error" id="room-error" hidden />

        <section class="room-join" id="join-panel" hidden>
          <div class="room-invite is-join">
            <Mosaic seed="" />
            <div class="room-invite-head">
              <p class="room-label">You’re invited · Room {code}</p>
              <h1 class="room-invite-title" data-room="category" />
              <p class="room-invite-sub" id="join-mode" />
            </div>
          </div>
          <p class="room-who" id="join-who" hidden>
            <span class="mono-stack" />
            <span class="room-who-text" />
          </p>
          <form id="join-form" class="room-join-card">
            <h2 class="room-join-title">Pick a nickname</h2>
            <p class="room-note">
              1–20 characters. This device remembers it for the next room.
            </p>
            <div class="room-field">
              <label class="sr-only" for="nickname">
                Nickname
              </label>
              <input
                class="field"
                id="nickname"
                name="nickname"
                type="text"
                minlength={1}
                maxlength={20}
                autocomplete="nickname"
                placeholder="Your nickname"
                required
              />
              <span class="room-field-count" id="nickname-count">
                0/20
              </span>
            </div>
            <button class="btn is-primary is-lg is-block" type="submit">
              Join the room <kbd class="room-kbd">Enter</kbd>
            </button>
            {user === null && (
              <>
                <p class="room-or">or</p>
                <SignInButtons next={back} />
                <p class="room-note is-center">
                  Play under your profile name and keep your points.
                </p>
              </>
            )}
          </form>
        </section>

        <section class="room-lobby" id="lobby-panel" hidden>
          <div class="room-lobby-main">
            <div class="room-invite">
              <div class="room-invite-top">
                <Mosaic seed="" />
                <div class="room-invite-head">
                  <h1 class="room-invite-title" data-room="category" />
                  <p class="room-invite-sub" id="lobby-mode" />
                </div>
              </div>
              <div class="room-code-row">
                <p class="room-label">Room code</p>
                <p class="room-code">{code}</p>
              </div>
              <div class="room-share">
                <label class="sr-only" for="room-link">
                  Room link
                </label>
                <input
                  class="room-link"
                  id="room-link"
                  type="text"
                  readonly
                  value={back}
                />
                <button class="room-copy" id="copy-link" type="button">
                  {copyIcon}
                  <span>Copy</span>
                </button>
                <button
                  class="room-share-native"
                  id="share-link"
                  type="button"
                  hidden
                >
                  {shareIcon}
                  Share
                </button>
              </div>
            </div>
            <div class="room-sound" id="sound-check">
              <span class="room-sound-icon">{soundOffIcon}</span>
              <p>
                <strong>Sound is off here.</strong> Rounds start on every device
                at once. Tap once so this one can play them.
              </p>
              <button class="room-sound-on" id="sound-on" type="button">
                Turn on sound
              </button>
            </div>
          </div>
          <div class="room-lobby-side">
            <section class="room-players">
              <h2 class="room-players-head">
                Players <small id="players-count" />
              </h2>
              <ul class="room-people" id="lobby-players" />
            </section>
            <a class="room-tv" href={`/play/room/${code}/screen`}>
              {tvIcon}
              <span>
                <strong>Show the room on a TV</strong>
                <small>Playing in one place? The clips play there.</small>
              </span>
              {chevronIcon}
            </a>
            <div class="results-actions room-actions" id="lobby-actions">
              <PillLink large href="/" id="change-category">
                Change category
              </PillLink>
              <PillButton
                variant="primary"
                large
                id="start-button"
                type="button"
              >
                Start the game <kbd class="room-kbd">Enter</kbd>
              </PillButton>
              <p class="room-wait" id="lobby-wait" />
            </div>
          </div>
        </section>

        <div id="round" data-phase="question" hidden>
          <p class="label round-count" id="round-count" />
          <ClipPlayer
            audioId="clip"
            toggleId="clip-toggle"
            barId="count-bar"
            leftId="count-left"
            worthId="count-worth"
            volumeId="clip-volume"
            round={`Round 1 of ${roundsPerGame}`}
          />
          <h1 class="round-title">Which song is this?</h1>
          <div class="choices" id="choices" />
          <form id="typed-form" class="guess" hidden>
            <div class="form-row">
              <label for="typed-answer">Song title</label>
              <input
                id="typed-answer"
                name="answer"
                type="text"
                autocomplete="off"
              />
            </div>
            <div>
              <PillButton variant="primary" type="submit">
                Guess
              </PillButton>
            </div>
          </form>
          <dl class="reveal-typed" id="typed-verdict" hidden>
            <div>
              <dt>You typed</dt>
              <dd id="typed-given" />
            </div>
          </dl>
          <div class="room-slot" id="room-slot">
            <p class="room-slot-head">
              <span>Answered</span>
              <b id="answered-count" />
            </p>
            <ul class="room-chips" id="round-chips" aria-label="Players" />
            <p class="room-note">
              The round ends early once everyone has answered.
            </p>
          </div>
          <div class="sheet" id="sheet" hidden>
            <div class="sheet-in">
              <b class="sheet-heading" id="sheet-verdict" aria-live="polite" />
              <span class="sheet-points" id="sheet-points" />
              <p class="sheet-sub">
                <span id="sheet-sub" />
                <span class="room-until" aria-hidden="true">
                  <i id="sheet-until" />
                </span>
              </p>
              <ul
                class="room-points"
                id="sheet-chips"
                aria-label="This round"
              />
            </div>
          </div>
        </div>

        <div class="results room-done" id="done-panel" hidden>
          <div class="results-main">
            <section class="score-card" aria-labelledby="score-label">
              <div class="score-top">
                <h1 class="score-label" id="score-label">
                  Game over
                </h1>
                <span class="score-best" id="score-best" hidden />
              </div>
              <p class="score-n" id="score-n" />
              <p class="score-rank" id="score-rank" />
              <ol class="score-pips" id="score-pips" />
            </section>
            <dl class="results-stats" id="done-stats" />
            <SaveScoreCard id="done-save" title="" next={back} hidden />
            <div class="results-actions room-actions">
              <PillLink large href="/" id="done-change">
                Change category
              </PillLink>
              <PillButton
                variant="primary"
                large
                id="rematch-button"
                type="button"
              >
                Rematch <kbd class="room-kbd">Enter</kbd>
              </PillButton>
              <p class="room-wait" id="done-wait" />
            </div>
          </div>
          <section class="results-card room-standings">
            <h2>
              Standings <small>this room</small>
            </h2>
            <ol class="board-rows" id="done-standings" />
          </section>
          <section class="results-card results-rounds">
            <h2>
              Rounds <small>who got each song</small>
            </h2>
            <ol class="round-rows" id="done-rounds" />
          </section>
          <section class="results-card room-board" id="done-board-card">
            <h2>
              Top scores{" "}
              <small id="done-board-note" data-days={categoryBoardDays}>
                last {categoryBoardDays} days
              </small>
            </h2>
            <ol class="board-rows" id="done-board" />
            <p class="board-foot" id="done-board-foot" hidden>
              <a href={providerHref("google", back)}>Sign in</a> to put your
              next room scores on the board.
            </p>
          </section>
        </div>

        <section class="room-closed" id="closed-panel" hidden>
          <div class="room-closed-card">
            <p class="room-closed-code" id="closed-code" aria-hidden="true">
              {[...code].map((char) => (
                <span>{char}</span>
              ))}
            </p>
            <p class="mono-stack room-closed-seats" id="closed-seats" hidden />
            <h1 class="room-closed-title" id="closed-title">
              This room has closed
            </h1>
            <p class="room-closed-text" id="closed-text">
              The game here is over. Start a new one from any category on the
              hub.
            </p>
            <form method="post" action="/play" id="closed-solo" hidden>
              <input type="hidden" name="category" id="closed-category" />
              <input type="hidden" name="mode" id="closed-mode" />
              <button class="btn is-primary is-lg is-block" type="submit">
                Play <span data-room="category" /> solo
              </button>
            </form>
            <a class="btn is-lg is-block room-closed-back" href="/">
              Back to the hub
            </a>
          </div>
        </section>

        <template id="now-template">
          {nowPlaying(
            {
              trackKey: "",
              title: "",
              artist: "",
              cover: null,
              link: "#",
            },
            "",
            back,
          )}
        </template>
        <template id="check-template">{checkIcon}</template>
        <template id="cross-template">{crossIcon}</template>
        {quitDialog()}
        <script src="/wave.js" defer />
        <script src="/room.js" defer />
      </div>
    ),
  });
}
