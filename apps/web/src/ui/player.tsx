// The waveform's bars: fixed heights and timings, so every round draws the
// same shape and the server renders it once. The phone shows the first 34.
export const waveBars = Array.from({ length: 46 }, (_, i) => {
  const scale = 0.3 + 0.7 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45));
  const duration = 0.45 + ((i * 37) % 45) / 100;
  return `--s:${scale.toFixed(2)};--d:${duration.toFixed(2)}s;--delay:${(-i * 0.13).toFixed(2)}s`;
});

// The clip's stage, shared by the solo round page and the room's phone page:
// the play toggle inside the countdown ring, a waveform that moves while the
// clip plays, the seconds left and the points a right answer is worth now.
// The ring reads --left, the share of the round still to run, from the
// element with barId. The <audio> starts with native controls so a no-JS
// page still plays; the client script removes them and drives the toggle.
export function ClipPlayer({
  src,
  label,
  audioId,
  toggleId,
  barId,
  leftId,
  worthId,
  volumeId,
  timerWaits = false,
  round,
}: {
  src?: string;
  label?: string;
  // "Round 3 of 10": on a phone the stage carries the round and the
  // question beside the ring, in the slots the now-playing card fills on the
  // reveal, so the answers below do not move.
  round?: string;
  audioId: string;
  toggleId: string;
  barId: string;
  leftId: string;
  worthId: string;
  volumeId?: string;
  // Solo starts the clock on the clip's first sound; a room's clock runs on
  // the server whether or not this phone plays.
  timerWaits?: boolean;
}) {
  return (
    <div class="player">
      <div class="player-top">
        {label && <span class="player-tag">{label}</span>}
        {volumeId && (
          <span class="player-sound">
            <button
              class="player-mute"
              id={`${volumeId}-mute`}
              type="button"
              aria-label="Mute the clip"
              aria-pressed="false"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path class="mute-body" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                <path
                  class="mute-on"
                  d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"
                />
                <path class="mute-off" d="M16 9.5l5 5M21 9.5l-5 5" />
              </svg>
            </button>
            <input
              type="range"
              class="player-volume"
              id={volumeId}
              min="0"
              max="100"
              aria-label="Clip volume"
              hidden
            />
          </span>
        )}
      </div>
      <div class="player-ring" id={barId}>
        <button
          class="player-toggle"
          id={toggleId}
          type="button"
          aria-label="Play or pause the clip"
          hidden
        >
          <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true" hidden>
            <rect x="6" y="5" width="4.5" height="14" rx="1.3" />
            <rect x="13.5" y="5" width="4.5" height="14" rx="1.3" />
          </svg>
        </button>
        <span class="player-loading" aria-live="polite">
          Loading clip
        </span>
      </div>
      {round && (
        <div class="player-head">
          <p class="player-round">{round}</p>
          <p class="player-ask">Which song is this?</p>
        </div>
      )}
      <div class="player-wave" aria-hidden="true">
        {waveBars.map((style) => (
          <i style={style} />
        ))}
      </div>
      <p class="player-hint">
        <b>Tap to start the clip</b>
        Your browser holds sound until you tap.
        {timerWaits && " The timer waits too."}
      </p>
      {timerWaits && (
        <p class="player-wait">The 15 s timer starts with the sound.</p>
      )}
      <div class="player-foot">
        <span class="player-time">
          <b id={leftId}>15</b> s left
        </span>
        <span class="player-worth">
          worth <b id={worthId}>1000</b>
        </span>
      </div>
      <audio id={audioId} src={src} controls preload="auto" />
      <noscript>
        <style
          dangerouslySetInnerHTML={{
            __html: ".player audio { display: block; }",
          }}
        />
      </noscript>
    </div>
  );
}
