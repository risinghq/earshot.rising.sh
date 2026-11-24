// Outbound requests in the Worker tests. A test answers the services it
// expects with network.use(); any other request fails the test, so none
// reaches the real Deezer, Apple or GitHub.
import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw";

export const network = setupNetwork();
network.configure({ onUnhandledFrame: "error" });

export const deezerTrack = (id: number, title = "x") => ({
  id,
  title,
  link: `https://www.deezer.com/track/${id}`,
  preview: `https://cdn.example/${id}.mp3`,
  artist: { name: "Artist" },
  album: { cover_medium: `https://cdn.example/${id}.jpg` },
});

// Deezer answers every track id with a clip named after it.
export const deezerTracks = () =>
  http.get("https://api.deezer.com/track/:id", ({ params }) =>
    HttpResponse.json(deezerTrack(Number(params.id))),
  );
