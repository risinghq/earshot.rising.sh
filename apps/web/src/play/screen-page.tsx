import { Mosaic } from "../ui/person";
import { waveBars } from "../ui/player";
import { soundMark } from "../ui/shell";
import { qrMatrix } from "./qr";
import { roundsPerGame } from "./quiz";

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
      class="tv-qr"
      viewBox={`${-quiet} ${-quiet} ${size} ${size}`}
      role="img"
      aria-label={`QR code for ${text}`}
    >
      <path d={parts.join("")} />
    </svg>
  );
}

const soundOffIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="is-solid" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);

const segments = (
  <ol class="tv-segs" aria-hidden="true">
    {Array.from({ length: roundsPerGame }, () => (
      <li />
    ))}
  </ol>
);

// The screen page is a full-viewport document, not the site shell: a TV has
// no use for site navigation. public/screen.js follows the room over its
// WebSocket and shows the panel matching the broadcast phase. The screen
// plays the clip and shows the game; the phones answer. The layout comes
// from the Claude Design file "Earshot Room", drawn at 1920×1080.
export function screenPage(code: string, joinUrl: string) {
  // qrMatrix only covers versions 1-6; an unusually long origin leaves the
  // link but skips the code rather than 500ing the page.
  let qr = null;
  try {
    qr = qrSvg(joinUrl);
  } catch {}
  const url = new URL(joinUrl);
  const codePill = <p class="tv-code-pill">{code}</p>;
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
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/styles.css" />
        <title>{`Room ${code} on screen · Earshot`}</title>
      </head>
      <body class="screen-view">
        <main id="screen" class="tv" data-code={code} data-phase="connecting">
          <noscript>
            <p class="tv-message">
              This screen needs JavaScript: it follows the room over a live
              connection.
            </p>
          </noscript>
          <p class="tv-message" id="screen-error" hidden />

          <section class="tv-panel tv-lobby" id="screen-lobby" hidden>
            <header class="tv-top">
              <p class="tv-brand">
                {soundMark}
                Earshot
              </p>
              <div class="tv-room">
                <Mosaic seed="" />
                <p>
                  <b data-room="category" />
                  <span id="screen-mode" />
                </p>
              </div>
            </header>
            <div class="tv-lobby-main">
              <div>
                <p class="tv-ask">Join on your phone</p>
                <p class="tv-code" aria-label={`Room code ${code}`}>
                  {[...code].map((char) => (
                    <span>{char}</span>
                  ))}
                </p>
                <div class="tv-join">
                  {qr}
                  <p>
                    <span>or open</span>
                    <b class="tv-link">
                      {url.host}
                      <br />
                      {url.pathname}
                    </b>
                  </p>
                </div>
              </div>
              <section class="tv-players">
                <h2>
                  Players <small id="screen-seats" />
                </h2>
                <ul class="tv-seats" id="screen-roster" />
              </section>
            </div>
            <p class="tv-wait" id="screen-lobby-hint" />
          </section>

          <section class="tv-panel tv-round" id="screen-game" hidden>
            <header class="tv-top">
              <p class="tv-kicker" id="screen-round-title" />
              {segments}
              {codePill}
            </header>
            <div class="tv-round-main">
              <div class="tv-ring" id="screen-ring" style="--left:1">
                <p>
                  <b id="screen-count">15</b>
                  <span id="screen-worth">seconds · worth 1,000</span>
                </p>
              </div>
              <div>
                <h1 class="tv-ask-big">Which song is this?</h1>
                <p class="tv-sub" id="screen-loading">
                  Answer on your phone.
                </p>
                <div class="tv-wave" aria-hidden="true">
                  {waveBars.slice(0, 40).map((style) => (
                    <i style={style} />
                  ))}
                </div>
              </div>
            </div>
            <ul class="tv-answers" id="screen-answers" />
          </section>

          <section class="tv-panel tv-reveal" id="screen-reveal" hidden>
            <header class="tv-top">
              <p class="tv-kicker" id="screen-reveal-title" />
              {segments}
              <p class="tv-next" id="screen-next" />
            </header>
            <div class="tv-reveal-main">
              <div>
                <div class="tv-cover" id="screen-cover">
                  <img id="screen-reveal-cover" alt="" hidden />
                </div>
                <p class="tv-now">
                  <span class="tv-eq" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  Now playing
                </p>
              </div>
              <div>
                <h1 class="tv-song" id="screen-reveal-track" />
                <p class="tv-artist" id="screen-reveal-artist" />
                <ul class="tv-results" id="screen-reveal-scores" />
              </div>
            </div>
          </section>

          <section class="tv-panel tv-final" id="screen-final" hidden>
            <header class="tv-top">
              <p class="tv-kicker">
                Game over · <span data-room="category" />
              </p>
              {codePill}
            </header>
            <div class="tv-final-main">
              <div class="tv-winner">
                <p class="tv-winner-label" id="screen-winner-label">
                  Winner
                </p>
                <p class="tv-winner-who" id="screen-winner" />
                <p class="tv-winner-score" id="screen-winner-score" />
                <p class="tv-winner-correct" id="screen-winner-correct" />
              </div>
              <ol class="tv-standings" id="screen-standings" />
            </div>
            <p class="tv-wait" id="screen-final-hint" />
          </section>
        </main>
        <audio id="screen-clip" preload="auto" />
        <button class="tv-sound" id="screen-sound" type="button" hidden>
          {soundOffIcon}
          Click once to turn on sound
        </button>
        <script src="/wave.js" defer />
        <script src="/screen.js" defer />
      </body>
    </html>
  );
}
