// The clip's stage, as the server's ClipPlayer draws it (src/ui/player.tsx):
// the play toggle inside the countdown ring, a waveform that moves while
// the clip plays, the seconds left and what a right answer is worth now.
// On the reveal the now-playing card joins it with the clip still running.
import { For, Show, createEffect, onSettled } from "solid-js";
import { roundsPerGame, scoreFor } from "../../src/play/rules";
import { waveBars } from "../../src/ui/marks";
import { clipWave } from "../wave";
import { MuteIcon } from "./icons";
import { roundMs, type Room } from "./model";
import { NowPlaying } from "./NowPlaying";

export function Stage(props: { room: Room }) {
  const room = props.room;
  const clip = room.clip;
  let audio!: HTMLAudioElement;
  let wave!: HTMLDivElement;
  const s = () => room.state();
  const rounds = () => s()?.rounds ?? roundsPerGame;
  const reveal = () =>
    room.stagePhase() === "reveal" ? s()?.reveal : undefined;

  onSettled(() => {
    clip.attach(audio, room.opened);
    clipWave(audio, wave);
  });
  createEffect(
    () => clip.playing(),
    (on) => {
      document.body.classList.toggle("clip-live", on);
    },
  );

  return (
    <div
      class={{
        player: true,
        "is-loading": room.waiting() !== null,
        "is-reveal": reveal() !== undefined,
      }}
    >
      <div class="player-top">
        <span class="player-sound">
          <button
            class="player-mute"
            id="clip-volume-mute"
            type="button"
            aria-label="Mute the clip"
            aria-pressed={clip.muted() ? "true" : "false"}
            onClick={() => clip.toggleMute()}
          >
            <MuteIcon />
          </button>
          <input
            type="range"
            class="player-volume"
            id="clip-volume"
            min="0"
            max="100"
            aria-label="Clip volume"
            value={String(clip.volumePercent())}
            hidden={!clip.canSetVolume}
            onInput={(event) =>
              clip.setVolume(Number(event.currentTarget.value))
            }
          />
        </span>
      </div>
      <div
        class="player-ring"
        id="count-bar"
        style={{ "--left": String(room.left() / roundMs) }}
      >
        <button
          class={{ "player-toggle": true, "needs-click": clip.needsClick() }}
          id="clip-toggle"
          type="button"
          aria-label="Play or pause the clip"
          onClick={() => clip.toggle()}
        >
          <Show
            when={clip.playing()}
            fallback={
              <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          >
            <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="5" width="4.5" height="14" rx="1.3" />
              <rect x="13.5" y="5" width="4.5" height="14" rx="1.3" />
            </svg>
          </Show>
        </button>
        {/* Before the clip starts the ring holds the round number and what
            to do. From 900px it reads large inside the ring; a phone keeps
            "7 of 10" in the ring and puts the words in the heading. */}
        <span class="player-loading" aria-live="polite">
          <Show when={room.waiting()} fallback="Loading clip">
            <small class="r-kick">Round</small>
            <b class="r-num">
              <span class="r-word">Round </span>
              {room.shownRound()}
            </b>
            <span class="r-of">of {rounds()}</span>
            <span class="r-go">{room.waiting()}</span>
          </Show>
        </span>
      </div>
      <div class="player-head">
        <p class="player-round">
          Round {Math.max(1, room.shownRound())} of {rounds()}
        </p>
        <p class="player-ask">{room.waiting() ?? "Which song is this?"}</p>
        <Show when={room.waiting() !== null}>
          <p class="player-sub">
            {s()?.screen
              ? "The clip plays on the TV."
              : "The clip starts on every phone at once."}
          </p>
        </Show>
      </div>
      <div class="player-wave" aria-hidden="true" ref={(el) => (wave = el)}>
        <For each={waveBars}>{(style) => <i style={style} />}</For>
      </div>
      <p class="player-hint">
        <b>Tap to start the clip</b>
        Your browser holds sound until you tap.
      </p>
      <div class="player-foot">
        <span class="player-time">
          <b id="count-left">{Math.ceil(room.left() / 1000)}</b> s left
        </span>
        <span class="player-worth">
          worth <b id="count-worth">{scoreFor(roundMs - room.left())}</b>
        </span>
      </div>
      <audio id="clip" preload="auto" ref={(el) => (audio = el)} />
      {/* Built once per reveal: a state message during it updates the
          card in place. */}
      <Show when={reveal() !== undefined}>
        <NowPlaying room={room} />
      </Show>
    </div>
  );
}
