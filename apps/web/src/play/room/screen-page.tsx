import { fontUrl, ScriptTag, Styles } from "../../ui/assets";
import { soundMark } from "../../ui/shell";
import { qrPath } from "./qr";

// The join link's QR code is rendered on the server: the screen needs it
// before the socket connects, and a static SVG needs no client library.
function qrSvg(text: string) {
  const { viewBox, d } = qrPath(text);
  return (
    <svg
      class="tv-qr"
      viewBox={viewBox}
      role="img"
      aria-label={`QR code for ${text}`}
    >
      <path d={d} />
    </svg>
  );
}

const soundOffIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="is-solid" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);

// The screen page is a full-viewport document, not the site shell: a TV has
// no use for site navigation. client/screen/ follows the room over its
// WebSocket and draws the panel matching the broadcast phase into #screen;
// the server sends what only it owns. The screen plays the clip and shows
// the game; the phones answer. The layout comes from the Claude Design file
// "Earshot Room", drawn at 1920×1080.
export function screenPage(code: string, joinUrl: string) {
  // qrMatrix only covers versions 1-6; an unusually long origin leaves the
  // link but skips the code rather than 500ing the page.
  let qr = null;
  try {
    qr = qrSvg(joinUrl);
  } catch {}
  const url = new URL(joinUrl);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="preload"
          href={fontUrl}
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <Styles names={["common", "screen"]} />
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
          {/* The brand mark and the join link with its QR code; the lobby
              takes a copy of each part. */}
          <template data-parts>
            <div data-part="mark">{soundMark}</div>
            <div data-part="join">
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
          </template>
        </main>
        <audio id="screen-clip" preload="auto" />
        <button class="tv-sound" id="screen-sound" type="button" hidden>
          {soundOffIcon}
          Click once to turn on sound
        </button>
        <ScriptTag name="screen" />
      </body>
    </html>
  );
}
