import type { SignedInUser } from "../auth";
import { Page } from "../ui/shell";

// The room page is a static shell: every panel exists in the markup and the
// client script in public/room.js shows the one matching the room's phase.
export function roomPage(code: string, user: SignedInUser | null) {
  return Page({
    title: `Room ${code} · Guess the song`,
    user,
    children: (
      <div id="room" data-code={code} class="stack">
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

        <section class="section" id="game-card" hidden>
          <div class="section-head">
            <h2 id="round-title">Which song is this?</h2>
            <small class="label">
              <span id="count-left">15</span> s left
            </small>
          </div>
          <div class="section-body">
            <div class="clip">
              <audio id="clip" controls preload="auto" />
              <div class="share">
                <span id="count-bar" style="transform: scaleX(1)" />
              </div>
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
          <div class="section-head">
            <h2 id="reveal-title">Reveal</h2>
            <small class="label">Next round soon</small>
          </div>
          <div class="section-body">
            <div class="reveal">
              <img id="reveal-cover" alt="" width="96" height="96" hidden />
              <div class="track">
                <b id="reveal-track" />
                <small class="muted" id="reveal-artist" />
                <a id="reveal-link" href="#" hidden>
                  Listen on Deezer
                </a>
              </div>
            </div>
            <ul class="rows" id="reveal-scores" />
          </div>
        </section>

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

        <script src="/room.js" defer />
      </div>
    ),
  });
}
