import type { SignedInUser } from "../auth";
import { ClipPlayer } from "../ui/player";
import { Page } from "../ui/shell";
import {
  checkIcon,
  coverTile,
  crossIcon,
  flagIcon,
  gameBar,
  quitDialog,
} from "./pages";
import { roundsPerGame } from "./quiz";

// The room page is a static shell: every panel exists in the markup and the
// client script in public/room.js shows the one matching the room's phase.
// While a game runs it wears the same game bar and feedback sheet as solo;
// room.js fills the sheet's fields and updates the bar by class selector.
export function roomPage(code: string, user: SignedInUser | null) {
  return Page({
    title: `Room ${code} · Guess the song`,
    user,
    chrome: "game",
    children: (
      <div id="room" data-code={code} class="stack">
        {gameBar({ done: 0, total: roundsPerGame, score: 0, streak: 0 })}
        <div class="page-head">
          <p class="meta" id="room-meta">
            Room {code}
          </p>
          <h1>Guess the song</h1>
        </div>
        <noscript>
          <p class="meta">
            This room needs JavaScript: it plays over a live connection.
          </p>
        </noscript>
        <p class="form-error" id="room-error" hidden />

        <section class="section" id="join-card" hidden>
          <div class="section-head">
            <h2>Join the room</h2>
          </div>
          <div class="section-body">
            <p class="meta">
              Send <b id="room-link">/play/room/{code}</b> to your friends, then
              pick a nickname to play.
            </p>
            <form id="join-form" class="guess">
              <div class="field">
                <label for="nickname">Nickname</label>
                <input
                  id="nickname"
                  name="nickname"
                  type="text"
                  minlength={1}
                  maxlength={20}
                  autocomplete="off"
                  autofocus
                  required
                />
              </div>
              <div>
                <button class="pill primary" type="submit">
                  Join
                </button>
              </div>
            </form>
          </div>
        </section>

        <section class="section" id="lobby-card" hidden>
          <div class="section-head">
            <h2>Lobby</h2>
          </div>
          <div class="section-body">
            <p class="meta" id="lobby-hint">
              Waiting for the room's creator to start the game.
            </p>
            <p class="meta">
              Playing together in one place?{" "}
              <a href={`/play/room/${code}/screen`}>
                Show this room on a TV or shared screen
              </a>
              .
            </p>
            <div>
              <button
                class="pill primary"
                id="start-button"
                type="button"
                hidden
              >
                Start the game
              </button>
            </div>
          </div>
        </section>

        <section class="section game-section" id="game-card" hidden>
          <div class="section-body">
            <div id="player-wrap">
              <ClipPlayer
                audioId="clip"
                toggleId="clip-toggle"
                barId="count-bar"
                leftId="count-left"
                volumeId="clip-volume"
              />
            </div>
            <p class="meta" id="clip-status" hidden>
              Loading the clip…
            </p>
            <div class="choices" id="choices" hidden />
            <form id="typed-form" class="guess" hidden>
              <div class="field">
                <label for="typed-answer">Song title</label>
                <input
                  id="typed-answer"
                  name="answer"
                  type="text"
                  autocomplete="off"
                />
              </div>
              <div>
                <button class="pill primary" type="submit">
                  Guess
                </button>
              </div>
            </form>
            <p class="meta" id="answer-status" hidden>
              Answer locked in. Waiting for the reveal.
            </p>
          </div>
        </section>

        <section class="section" id="reveal-card" hidden>
          <div class="section-body">
            <ul class="rows" id="reveal-scores" />
          </div>
        </section>

        <div class="sheet" id="room-sheet" hidden>
          <div class="sheet-in">
            <div class="sheet-verdict">
              <span id="sheet-check" hidden>
                {checkIcon}
              </span>
              <span id="sheet-cross" hidden>
                {crossIcon}
              </span>
              <b id="sheet-verdict" aria-live="polite" />
              <span class="sheet-points" id="sheet-points" />
            </div>
            <div class="sheet-song">
              {coverTile(null)}
              <div class="track">
                <b id="sheet-title" />
                <small class="muted" id="sheet-artist" />
                <a id="sheet-link" href="#" hidden>
                  Listen on Deezer
                </a>
              </div>
              <details class="report sheet-report" id="reveal-report" hidden>
                <summary aria-label="Report this clip">
                  <span class="report-flag">{flagIcon}</span>
                  <span class="report-label">Report this clip</span>
                </summary>
                <form class="report-form" method="post" action="/play/report">
                  <input type="hidden" name="track" id="report-track" />
                  <input type="hidden" name="title" id="report-title" />
                  <input type="hidden" name="artist" id="report-artist" />
                  <input type="hidden" name="category" id="report-category" />
                  <input type="hidden" name="back" id="report-back" />
                  <select name="reason" required>
                    <option value="wrong_song">Wrong song</option>
                    <option value="bad_clip">Bad clip</option>
                    <option value="wrong_title">Wrong title</option>
                    <option value="other">Other</option>
                  </select>
                  <button class="pill small" type="submit">
                    Send report
                  </button>
                  <small class="muted report-failed" hidden>
                    Could not send the report. Try again later.
                  </small>
                </form>
              </details>
            </div>
            <p class="sheet-next meta" id="sheet-next">
              Next round soon
            </p>
          </div>
        </div>

        <section class="section" id="final-card" hidden>
          <div class="section-head">
            <h2>Game over</h2>
          </div>
          <div class="section-body">
            <ol class="ranked" id="standings" />
            <div>
              <small class="label">Top scores in this category</small>
              <ul class="rows" id="board" />
              <p class="hint" id="board-empty" hidden>
                No scores in the last 15 days.
              </p>
            </div>
            <p class="meta" id="points-hint" hidden>
              <a href="/auth/github">Sign in</a> to keep your points on the{" "}
              <a href="/play/board">board</a>.
            </p>
            <div class="modes">
              <button
                class="pill primary"
                id="rematch-button"
                type="button"
                hidden
              >
                Rematch
              </button>
              <a class="pill" href="/play">
                Back to categories
              </a>
            </div>
          </div>
        </section>

        <section class="section" id="players-card" hidden>
          <div class="section-head">
            <h2>Players</h2>
          </div>
          <div class="section-body">
            <ul class="rows" id="players" />
          </div>
        </section>

        {quitDialog()}
        <script src="/room.js" defer />
      </div>
    ),
  });
}
