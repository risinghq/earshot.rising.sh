import { type Child } from "hono/jsx";
import { type Game } from "./game";

export const quitIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

export const trophyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4h10v3h3v2a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1A5 5 0 0 1 8.3 13H8a4 4 0 0 1-4-4V7h3zm0 5V9H6a2 2 0 0 0 1 1.7zm10 0v1.7A2 2 0 0 0 18 9z" />
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

export function streakOf(results: Game["results"]) {
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i].correct; i--)
    streak += 1;
  return streak;
}

export function bestStreak(results: Game["results"]) {
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
export function gameBar({
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

// The cover's tile always holds its space, so the artwork never pops the
// sheet open late: a neutral square behind the image.
export function coverTile(src: string | null, size = 56) {
  return (
    <span class="cover-tile" style={`width:${size}px;height:${size}px`}>
      {src && <img src={src} alt="" width={size} height={size} />}
    </span>
  );
}
