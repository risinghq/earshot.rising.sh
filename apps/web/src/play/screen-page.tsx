import { qrMatrix } from "./qr";

// The join link's QR code is rendered on the server: the screen needs it
// before the socket connects, and a static SVG needs no client library.
function qrSvg(text: string) {
  const matrix = qrMatrix(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const parts: string[] = [];
  matrix.forEach((row, r) => {
    for (let c = 0; c < matrix.length;) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let end = c + 1;
      while (end < matrix.length && row[end]) end += 1;
      parts.push(`M${c} ${r}h${end - c}v1H${c}z`);
      c = end;
    }
  });
  return (
    <svg
      class="screen-qr"
      viewBox={`${-quiet} ${-quiet} ${size} ${size}`}
      role="img"
      aria-label={`QR code for ${text}`}
    >
      <path d={parts.join("")} />
    </svg>
  );
}

// The screen page is a full-viewport document, not the site shell: a TV has
// no use for site navigation or the 640px card. public/screen.js follows the
// room over its WebSocket and shows the panel matching the broadcast phase;
// the screen plays the clip and shows the game and has no answer controls.
export function screenPage(code: string, joinUrl: string) {
  // qrMatrix only covers versions 1-6; an unusually long origin leaves the
  // link but skips the code rather than 500ing the page.
  let qr = null;
  try {
    qr = qrSvg(joinUrl);
  } catch {}
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="preload"
          href="/bricolage-latin.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="stylesheet" href="/styles.css" />
        <title>{`Room ${code} on screen · Earshot`}</title>
      </head>
      <body class="screen-view">
        <main id="screen" data-code={code}>
          <noscript>
            <p class="screen-note">
              This screen needs JavaScript: it follows the room over a live
              connection.
            </p>
          </noscript>
          <p class="form-error" id="screen-error" hidden />

          <section class="screen-panel" id="screen-lobby" hidden>
            <div class="screen-join">
              <div class="screen-join-text">
                <p class="screen-kicker" id="screen-category">
                  Guess the song
                </p>
                <p class="screen-code">{code}</p>
                <p class="screen-link">{joinUrl}</p>
                <p class="screen-note">
                  Point a phone camera at the code or open the link to join.
                </p>
              </div>
              {qr}
            </div>
            <ul class="screen-list" id="screen-roster" />
            <p class="screen-note" id="screen-lobby-hint">
              Waiting for the room's creator to start the game.
            </p>
          </section>

          <section class="screen-panel" id="screen-game" hidden>
            <header class="screen-head">
              <h1 class="screen-title" id="screen-round-title">
                Which song is this?
              </h1>
              <p class="screen-count">
                <span id="screen-count">15</span> s
              </p>
            </header>
            <div class="screen-bar">
              <span id="screen-bar" style="transform: scaleX(1)" />
            </div>
            <p class="screen-note" id="screen-loading">
              Getting the next song ready…
            </p>
            <div class="screen-round">
              <ol class="screen-choices" id="screen-choices" />
              <ul class="screen-list" id="screen-answers" />
            </div>
          </section>

          <section class="screen-panel" id="screen-reveal" hidden>
            <div class="screen-reveal">
              <img
                id="screen-reveal-cover"
                alt=""
                width="320"
                height="320"
                hidden
              />
              <div class="screen-reveal-info">
                <p class="screen-kicker" id="screen-reveal-title">
                  Reveal
                </p>
                <h1 class="screen-title" id="screen-reveal-track" />
                <p class="screen-artist" id="screen-reveal-artist" />
                <a
                  class="screen-deezer"
                  id="screen-reveal-link"
                  href="#"
                  hidden
                >
                  Listen on Deezer
                </a>
              </div>
            </div>
            <ul class="screen-list" id="screen-reveal-scores" />
          </section>

          <section class="screen-panel" id="screen-final" hidden>
            <h1 class="screen-title">Game over</h1>
            <div class="screen-final">
              <ol class="screen-list" id="screen-standings" />
              <div class="screen-board">
                <p class="screen-kicker">Top scores in this category</p>
                <ul class="screen-list" id="screen-board" />
                <p class="screen-note" id="screen-board-empty" hidden>
                  No scores in the last 15 days.
                </p>
              </div>
            </div>
            <p class="screen-note">
              The room's creator starts a rematch from their phone.
            </p>
          </section>
        </main>
        <audio id="screen-clip" preload="auto" />
        <input
          type="range"
          class="screen-volume"
          id="screen-volume"
          min="0"
          max="100"
          aria-label="Clip volume"
          hidden
        />
        <button class="screen-sound" id="screen-sound" type="button" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
          Turn the sound on
        </button>
        <script src="/screen.js" defer />
      </body>
    </html>
  );
}
