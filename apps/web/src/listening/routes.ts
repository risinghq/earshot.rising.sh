import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";
import { submitListens, validateToken } from "./listenbrainz";
import { beginSpotify, spotifyCallback } from "./spotify";
import { uploadPlays } from "./upload";

// The endpoints listening sources call: the YouTube Music upload, the
// ListenBrainz-compatible API and Spotify's OAuth.
export const listeningApp = new Hono<{ Bindings: Env }>();

listeningApp.post(
  "/api/v1/upload",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (context) =>
      context.json({ error: "the body is over the 256 KiB limit" }, 413),
  }),
  uploadPlays,
);

// Pano Scrobbler joins the configured server to "1/" and the route name, so a
// server entered as https://earshot.rising.sh or .../1 both reach these routes.
listeningApp.on(
  "POST",
  ["/1/submit-listens", "/1/1/submit-listens"],
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (context) =>
      context.json(
        { code: 413, error: "The body is over the 512 KiB limit." },
        413,
      ),
  }),
  submitListens,
);

listeningApp.on(
  "GET",
  ["/1/validate-token", "/1/1/validate-token"],
  validateToken,
);

listeningApp.all("/1/*", (context) =>
  context.json({ code: 404, error: "Not found." }, 404),
);

listeningApp.get("/auth/spotify", (context) => beginSpotify(context));

listeningApp.get("/auth/spotify/callback", (context) =>
  spotifyCallback(context),
);
