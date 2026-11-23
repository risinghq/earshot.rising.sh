import { providerHref, type SignedInUser } from "../auth";
import { ScriptTag } from "../ui/assets";
import { SaveScoreCard, SignInButtons } from "../ui/empty";
import { Mosaic } from "../ui/person";
import { PillButton } from "../ui/pill";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import {
  checkIcon,
  crossIcon,
  gameBar,
  modeNames,
  nowPlaying,
  quitDialog,
  quitIcon,
} from "./pages";
import { modes, roundsPerGame } from "./quiz";
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

const backIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
const devicesIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="4" width="14" height="10" rx="2" />
    <path d="M6 18h6" />
    <rect x="16" y="9" width="6" height="11" rx="1.5" />
  </svg>
);
const lockIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

const devicesButton = (
  <button
    class="room-devices"
    type="button"
    data-devices
    aria-haspopup="dialog"
  >
    {devicesIcon}
    Devices
  </button>
);

// A field holding a link, with its copy button; room.js wires [data-copy].
function linkField(id: string, label: string, value = "") {
  return (
    <div class="room-share">
      <label class="sr-only" for={id}>
        {label}
      </label>
      <input class="room-link" id={id} type="text" readonly value={value} />
      <button class="room-copy" type="button" data-copy={id}>
        {copyIcon}
        <span>Copy</span>
      </button>
    </div>
  );
}

// The Devices sheet: put the room on a TV, or move this seat to another
// device. The seat link carries the seat's key, which only this device
// holds, so room.js fills it and its QR code.
function devicesSheet(code: string) {
  const screen = `/play/room/${code}/screen`;
  return (
    <dialog
      class="pick-sheet room-sheet"
      id="devices-sheet"
      aria-labelledby="devices-title"
    >
      <span class="pick-grab" aria-hidden="true" />
      <div class="pick-head">
        <h2 id="devices-title">Devices</h2>
        <button
          class="pick-close"
          id="devices-close"
          type="button"
          aria-label="Close"
        >
          {closeIcon}
        </button>
      </div>
      <section class="room-dev-item" aria-labelledby="dev-tv">
        <h3 id="dev-tv">Show on a TV</h3>
        <p id="dev-tv-note">
          Open this link in the TV’s browser. While it is open, the clips play
          there and phones only answer.
        </p>
        {linkField("tv-link", "TV link", screen)}
        <a class="btn is-block" href={screen} target="_blank" rel="noopener">
          {tvIcon}
          Open the TV screen here
        </a>
      </section>
      <section class="room-dev-item is-move" aria-labelledby="dev-move">
        <img class="room-dev-qr" id="seat-qr" alt="" width={112} height={112} />
        <div class="room-dev-text">
          <h3 id="dev-move">Move to another device</h3>
          <p>
            Scan the code or open the link there. Your seat moves with your
            score and streak.
          </p>
        </div>
        {linkField("seat-link", "Your seat link")}
        <p class="room-seat-warn">
          {lockIcon}
          This link is your seat. Don’t share it: whoever opens it plays as you.
        </p>
      </section>
    </dialog>
  );
}

const closeIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const searchIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
  </svg>
);

// The sheet picks the room's next category: a player suggests it, the host
// plays it after a game or sets it in the lobby. room.js fills the list from
// /play/picks and sets the title and the button for its purpose.
function pickSheet(code: string) {
  return (
    <dialog class="pick-sheet" id="pick-sheet" aria-labelledby="pick-title">
      <span class="pick-grab" aria-hidden="true" />
      <div class="pick-head">
        <h2 id="pick-title">Suggest next game</h2>
        <button
          class="pick-close"
          id="pick-close"
          type="button"
          aria-label="Close"
        >
          {closeIcon}
        </button>
      </div>
      <div class="pick-tabs" role="tablist" aria-label="Pick from">
        <button type="button" role="tab" id="pick-tab-genre" data-tab="genre">
          Genre
        </button>
        <button type="button" role="tab" id="pick-tab-artist" data-tab="artist">
          Artist
        </button>
      </div>
      <label class="pick-search" id="pick-search" hidden>
        {searchIcon}
        <span class="sr-only">Artist</span>
        <input
          type="search"
          id="pick-q"
          placeholder="Search an artist"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
        />
      </label>
      <p class="pick-status" id="pick-status" aria-live="polite" />
      <ul class="pick-results" id="pick-list" />
      <div class="pick-modes" role="group" aria-label="Mode">
        {modes.map((mode) => (
          <button type="button" data-mode={mode} aria-pressed="false">
            {modeNames[mode]}
          </button>
        ))}
      </div>
      <button
        class="btn is-primary is-lg is-block"
        id="pick-go"
        type="button"
        disabled
      >
        Pick one above
      </button>
      <a class="pick-hub" id="pick-hub" href={`/?room=${code}`}>
        Pick an era on the hub
      </a>
    </dialog>
  );
}

// The room page is one shell for every phase. client/room.js shows the panel
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
    styles: ["common", "game", "room"],
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
          tools: devicesButton,
        })}
        <div class="results-head">
          <a class="results-quit" href="/" aria-label="Leave the room">
            {quitIcon}
          </a>
          <b id="room-name">Room {code}</b>
          {devicesButton}
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
              <PillButton large id="change-category" type="button">
                Change category
              </PillButton>
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
          {/* One card follows the round: who answered, then at the reveal
              what each player scored, under your verdict. From 900px the
              verdict takes the question's slot; on a phone the card turns
              into the bottom sheet with the verdict as its header. */}
          <div class="room-slot" id="room-slot">
            <p class="room-verdict" id="room-verdict" aria-live="polite">
              <b class="v-word" id="verdict-word" />
              <b class="v-pts" id="verdict-points" />
              <span class="v-place" id="verdict-place" />
            </p>
            <div class="room-slot-card">
              <p class="room-slot-head">
                <span id="slot-title">Answered</span>
                <b id="answered-count" />
              </p>
              <ul class="room-chips" id="round-chips" aria-label="Players" />
              <p class="room-note" id="slot-note">
                The round ends early once everyone has answered.
              </p>
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
            <div class="results-actions room-actions room-done-actions">
              <button
                class="btn is-primary is-lg room-two-line"
                id="rematch-button"
                type="button"
              >
                <span>
                  Rematch <kbd class="room-kbd">Enter</kbd>
                </span>
                <small id="rematch-sub" />
              </button>
              <button
                class="btn is-lg room-two-line"
                id="next-open"
                type="button"
              >
                <span>Next game →</span>
                <small id="next-open-sub" />
              </button>
              <p class="room-wait" id="done-wait" />
            </div>
            <SaveScoreCard id="done-save" title="" next={back} hidden />
          </div>
          {/* Next game is a step of the results, not a sheet: choosing
              takes the room a minute, and everyone sees the same list. */}
          <section
            class="room-next"
            id="next-panel"
            aria-labelledby="next-title"
            hidden
          >
            <button class="room-back" id="next-back" type="button">
              {backIcon}
              Results
            </button>
            <div class="room-next-head">
              <h1 id="next-title" tabindex={-1}>
                Next game
              </h1>
              <p id="next-sub" />
            </div>
            <section class="room-sugs" aria-labelledby="sugs-title">
              <div class="room-sugs-head">
                <h2 id="sugs-title">Suggestions</h2>
                <small id="up-next-live" />
              </div>
              <p class="room-sug-empty" id="up-next-empty">
                Nothing yet. Suggest a genre or an artist, and everyone votes.
              </p>
              <ol class="room-sug-list" id="up-next-list" />
            </section>
            <div class="room-mine" id="mine-card" hidden>
              <p>
                <small>Your suggestion</small>
                <b id="mine-name" />
              </p>
              <button class="room-mine-change" id="mine-change" type="button">
                Change
              </button>
            </div>
            <div class="room-mine-add" id="mine-add">
              <button class="btn" type="button" data-pick="genre">
                + Genre
              </button>
              <button class="btn" type="button" data-pick="artist">
                + Artist
              </button>
            </div>
            <div class="results-actions room-actions room-next-actions">
              <button class="btn is-lg" id="next-rematch" type="button">
                Rematch
              </button>
              <button class="btn is-primary is-lg" id="play-top" type="button">
                Play the top vote <kbd class="room-kbd">Enter</kbd>
              </button>
              <p class="room-wait" id="next-wait" />
            </div>
          </section>
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

        <section class="room-away" id="away-panel" hidden>
          <div class="room-away-card">
            <span class="room-away-icon">{devicesIcon}</span>
            <h1>Playing on your other device</h1>
            <p id="away-text">
              Your seat moved to another device, with your score and streak.
            </p>
            <button
              class="btn is-primary is-lg is-block"
              id="take-back"
              type="button"
            >
              Take the seat back here
            </button>
            <p class="room-away-note">
              The other device will show this screen instead.
            </p>
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
        {pickSheet(code)}
        {devicesSheet(code)}
        <ScriptTag name="room" />
      </div>
    ),
  });
}
