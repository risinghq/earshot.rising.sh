// The game's top bar, as the server's gameBar draws it (src/play/pages.tsx):
// a way out, the room's Devices, a segment per round and the score.
// Segments fill with this player's right and wrong answers; the current
// round is the accent one. On the reveal the round's segment is the
// countdown to the next round: it fills in the verdict's colour until the
// room moves on.
import { Repeat } from "solid-js";
import { modeNames, roundsPerGame } from "../../src/play/rules";
import { QuitIcon } from "./icons";
import type { Room } from "./model";
import { DevicesButton } from "./Devices";
import { me, number, verdictOf } from "./text";

// The quit control is a link, so it still leaves without the dialog; during
// a game it asks first. The dialog is the server's quitDialog.
function quit(event: MouseEvent) {
  const dialog = document.getElementById("quit-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return;
  event.preventDefault();
  dialog.showModal();
}

export function Bar(props: { room: Room; openDevices: () => void }) {
  const room = props.room;
  // The bar follows the room once this device holds a seat.
  const s = () => {
    const state = room.state();
    return state?.you.name ? state : null;
  };
  const total = () => s()?.rounds ?? roundsPerGame;
  const live = () => s()?.phase === "loading" || s()?.phase === "playing";
  const current = () =>
    s() === null ? 0 : live() ? (s()!.round ?? 1) - 1 : -1;
  const revealed = () =>
    s()?.phase === "reveal" ? s()!.reveal!.number - 1 : -1;
  const round = () => {
    const state = s();
    if (!state) return 1;
    return Math.max(
      1,
      Math.min(state.round ?? state.you.marks.length, state.rounds),
    );
  };
  const segment = (i: number) => {
    const marks = s()?.you.marks ?? [];
    if (i === revealed()) return { seg: true };
    return {
      seg: true,
      "is-done": i < marks.length,
      "is-right": i < marks.length && marks[i],
      "is-wrong": i < marks.length && !marks[i],
      "is-current": i === current(),
    };
  };
  const verdict = (i: number) =>
    i === revealed() && s()?.reveal
      ? verdictOf(s()!, s()!.reveal!) === "right"
        ? "right"
        : "wrong"
      : undefined;
  const mode = () => room.room()?.mode;

  return (
    <div class="game-bar">
      <a class="game-quit" href="/" aria-label="Leave the game" onClick={quit}>
        <QuitIcon />
      </a>
      <DevicesButton room={room} open={props.openDevices} />
      <ol
        class="game-progress"
        role="progressbar"
        aria-label={`Round ${round()} of ${total()}`}
        aria-valuenow={round()}
        aria-valuemin={0}
        aria-valuemax={total()}
      >
        <Repeat count={total()}>
          {(i) => (
            <li
              class={segment(i)}
              data-reveal={verdict(i)}
              style={
                verdict(i) ? { "--next-ms": `${room.revealMs()}ms` } : undefined
              }
            />
          )}
        </Repeat>
      </ol>
      <div class="game-side">
        <span class={{ "room-mode": true, "is-hard": mode() === "hard" }}>
          {mode() ? modeNames[mode()!] : ""}
        </span>
        <span class="game-score">
          <span class="game-score-n">
            {number(s() ? (me(s()!)?.score ?? 0) : 0)}
          </span>
        </span>
      </div>
    </div>
  );
}
