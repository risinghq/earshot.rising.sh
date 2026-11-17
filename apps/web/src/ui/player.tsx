// The styled clip player shared by the solo round page and the room's phone
// page: one toggle, the round countdown as the progress bar, and the seconds
// left. The <audio> starts with native controls so a no-JS page still plays;
// the client script removes them and drives the toggle instead.
export function ClipPlayer({
  src,
  audioId,
  toggleId,
  barId,
  leftId,
  volumeId,
}: {
  src?: string;
  audioId: string;
  toggleId: string;
  barId: string;
  leftId: string;
  volumeId?: string;
}) {
  return (
    <div class="player">
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
          <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
        </svg>
      </button>
      <div class="player-track">
        <span class="player-bar" id={barId} style="transform: scaleX(1)" />
      </div>
      <span class="player-time">
        <span id={leftId}>15</span> s
      </span>
      <input
        type="range"
        class="player-volume"
        id={volumeId}
        min="0"
        max="100"
        aria-label="Clip volume"
        hidden
      />
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

export const playSvg = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);
