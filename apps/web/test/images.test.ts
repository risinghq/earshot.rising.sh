import { env, SELF } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { fillImages, missRetrySeconds } from "../src/images";
import { readPage } from "./html";
import { network } from "./network";

const now = Math.floor(Date.now() / 1000);
const cover = "https://cdn-images.dzcdn.net/images/cover/abc/250x250.jpg";
const picture = "https://cdn-images.dzcdn.net/images/artist/def/250x250.jpg";

function stubDeezer(
  tracks: unknown[],
  artists: unknown[],
  seen: string[] = [],
) {
  network.use(
    http.get("https://api.deezer.com/search/artist", ({ request }) => {
      seen.push(request.url);
      return HttpResponse.json({ data: artists });
    }),
    http.get("https://api.deezer.com/search", ({ request }) => {
      seen.push(request.url);
      return HttpResponse.json({ data: tracks });
    }),
  );
}

async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (10, 1, 'spotify')",
    ),
    env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'weezer', 'Weezer')",
    ),
    env.DB.prepare(
      "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'weezer-buddyholly', 1, 'Buddy Holly')",
    ),
    env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, track_id) VALUES (1, ?1, 10, 1)",
    ).bind(now - 60),
  ]);
}

describe("fillImages", () => {
  it("stores a cover by the same artist and a picture by the same name", async () => {
    await seed();
    stubDeezer(
      [
        {
          artist: { name: "Weezer Tribute Band" },
          album: { cover_medium: "x" },
        },
        { artist: { name: "weezer" }, album: { cover_medium: cover } },
      ],
      [{ id: 5, name: "Weezer", picture_medium: picture }],
    );
    await fillImages(env, now);
    const track = await env.DB.prepare(
      "SELECT image, image_at FROM tracks WHERE id = 1",
    ).first();
    const artist = await env.DB.prepare(
      "SELECT image, image_at FROM artists WHERE id = 1",
    ).first();
    expect(track).toEqual({ image: cover, image_at: now });
    expect(artist).toEqual({ image: picture, image_at: now });

    const json = await (
      await SELF.fetch("https://music.rising.sh/u/alice.json")
    ).json<any>();
    expect(json.top_tracks[0].image).toBe(cover);
    expect(json.top_artists[0].image).toBe(picture);
    const page = await readPage(
      await (
        await SELF.fetch("https://earshot.rising.sh/u/alice?period=month")
      ).text(),
      "https://earshot.rising.sh",
    );
    expect(page.images).toContain(cover);
  });

  it("records a miss and looks it up again only after the retry window", async () => {
    await seed();
    const seen: string[] = [];
    stubDeezer(
      [],
      [{ name: "Weezer", picture_medium: "https://x/images/artist//250.jpg" }],
      seen,
    );
    await fillImages(env, now);
    expect(
      await env.DB.prepare("SELECT image, image_at FROM artists").first(),
    ).toEqual({ image: null, image_at: now });
    expect(seen).toHaveLength(2);

    await fillImages(env, now + 60);
    expect(seen).toHaveLength(2);

    await fillImages(env, now + missRetrySeconds + 1);
    expect(seen).toHaveLength(4);
  });

  it("leaves a row due when Deezer fails", async () => {
    await seed();
    network.use(
      http.get(
        "https://api.deezer.com/*",
        () => new HttpResponse("busy", { status: 503 }),
      ),
    );
    await fillImages(env, now);
    expect(await env.DB.prepare("SELECT image_at FROM tracks").first()).toEqual(
      { image_at: null },
    );
  });
});
