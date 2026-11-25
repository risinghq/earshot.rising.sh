import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { database } from "../src/platform/db";
import { sourceRemovalStatements } from "../src/listening/totals";
import { readPage, textAt, type ReadPage } from "./html";
import { network } from "./network";

const now = Math.floor(Date.now() / 1000);
const origin = "https://earshot.rising.sh";
const session = `sess_${"s".repeat(40)}`;

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
});

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUser(name = "alice", userId = 1) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(userId, userId * 1000, name, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(await sha256(session), userId, now + 30 * 86400)
    .run();
}

async function seedPlays(userId = 1, sourceId = 10, count = 3) {
  await env.DB.prepare(
    "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttrack', 1, 'Track')",
  ).run();
  for (let i = 0; i < count; i += 1) {
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (?1, ?2, ?3, ?4, 1)",
    )
      .bind(userId, now - 3600 * (i + 1), sourceId, `r${i}`)
      .run();
  }
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      headers: { cookie: `__Host-session=${session}`, ...headers },
    }),
    testEnv() as never,
  );
}

function post(path: string, fields: Record<string, string>, headers = {}) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        cookie: `__Host-session=${session}`,
        "content-type": "application/x-www-form-urlencoded",
        origin,
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    testEnv() as never,
  );
}

const read = async (response: Response) =>
  readPage(await response.text(), origin);

const linkTo = (page: ReadPage, path: string) =>
  page.links.find((link) => link.href === origin + path);

async function count(table: string, where = "1 = 1") {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

describe("session and origin", () => {
  it("shows anonymous visitors a sign-in card that returns to settings", async () => {
    const response = await app.fetch(
      new Request(`${origin}/settings`),
      testEnv() as never,
    );
    expect(response.status).toBe(200);
    const page = await read(response);
    expect(page.text).toContain("Sign in to see your settings");
    const returns = page.links.filter(
      (link) => new URL(link.href).searchParams.get("next") === "/settings",
    );
    expect(returns.length).toBeGreaterThan(0);
  });

  it("rejects an expired session", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, 1, ?2)",
    )
      .bind(await sha256(session), now - 10)
      .run();
    const response = await get("/settings");
    expect(response.status).toBe(200);
    expect((await read(response)).text).toContain(
      "Sign in to see your settings",
    );
  });

  it("serves the settings page to a signed-in user", async () => {
    await seedUser();
    const response = await get("/settings");
    expect(response.status).toBe(200);
    const page = await read(response);
    expect(page.text).toContain("Settings");
    expect(linkTo(page, "/u/alice")).toBeDefined();
    const profile = page.forms.find(
      (form) => form.action === `${origin}/settings/profile`,
    );
    expect(profile?.fields.name).toBe("alice");
  });

  it.each([
    ["a missing", {}],
    ["a foreign", { origin: "https://evil.example" }],
  ])("rejects a POST with %s Origin", async (_name, extra) => {
    await seedUser();
    const response = await app.fetch(
      new Request(`${origin}/settings/profile`, {
        method: "POST",
        headers: {
          cookie: `__Host-session=${session}`,
          "content-type": "application/x-www-form-urlencoded",
          ...extra,
        },
        body: "name=alice&is_public=on",
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(403);
  });

  it("reaches sign out from the account menu on any page", async () => {
    await seedUser();
    for (const path of ["/", "/play/board", "/settings"]) {
      const page = await read(await get(path));
      const signOut = page.forms.find(
        (form) => form.action === `${origin}/settings/sign-out`,
      );
      expect(signOut?.buttons.map((button) => button.label)).toEqual([
        "Sign out",
      ]);
      expect(linkTo(page, "/settings")).toBeDefined();
      expect(linkTo(page, "/u/alice")).toBeDefined();
    }
  });

  it("signs out by deleting the session row", async () => {
    await seedUser();
    const response = await post("/settings/sign-out", {});
    expect(response.status).toBe(303);
    const cleared = response.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("__Host-session=;");
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(await count("sessions")).toBe(0);
  });
});

describe("profile", () => {
  it("renames and hides", async () => {
    await seedUser();
    const response = await post("/settings/profile", { name: "ally" });
    expect(response.status).toBe(303);
    const user = await env.DB.prepare(
      "SELECT name, is_public FROM users WHERE id = 1",
    ).first<{ name: string; is_public: number }>();
    expect(user).toEqual({ name: "ally", is_public: 0 });
    expect((await get("/u/ally.json")).status).toBe(404);
  });

  it.each([
    ["a reserved name", "settings"],
    ["an invalid name", "Has Spaces"],
    ["a taken name", "taken"],
  ])("refuses %s", async (_name, name) => {
    await seedUser();
    if (name === "taken")
      await env.DB.prepare(
        "INSERT INTO users (github_id, name, created_at) VALUES (7, 'taken', ?1)",
      )
        .bind(now)
        .run();
    const response = await post("/settings/profile", { name });
    expect(response.status).toBe(400);
    expect((await read(response)).text).toContain("name");
    expect(
      (
        await env.DB.prepare("SELECT name FROM users WHERE id = 1").first<{
          name: string;
        }>()
      )?.name,
    ).toBe("alice");
  });
});

describe("sources", () => {
  it("offers Connect Spotify and a phone scrobbler section", async () => {
    await seedUser();
    const response = await get("/settings");
    expect(response.status).toBe(200);
    const html = await response.text();
    const page = await readPage(html, origin);
    expect(linkTo(page, "/auth/spotify")?.label).toBe("Connect Spotify");
    expect(page.text).toContain("Phone scrobbler");
    expect(page.text).toContain("Pano Scrobbler");
    // The server address a scrobbler is pointed at, shown to copy.
    expect(await textAt(html, "code")).toContain(origin);
    expect(page.forms.map((form) => form.action)).not.toContain(
      `${origin}/settings/sources`,
    );
  });

  it("lists a connected Spotify source", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'spotify-user')",
    ).run();
    const page = await read(await get("/settings"));
    expect(page.text).toContain("Spotify");
    expect(page.text).toContain("spotify-user");
  });

  it("removes a source and recounts all three totals", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'spotify-user')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (11, 1, 'ytmusic')",
    ).run();
    await seedPlays();
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 11, 'y1', 1)",
    )
      .bind(now - 600)
      .run();
    // A duplicate stays out of the totals, before the recount and after it.
    await env.DB.prepare(
      "INSERT INTO plays (user_id, played_at, source_id, ref, track_id, dup) VALUES (1, ?1, 10, 'd1', 1, 1)",
    )
      .bind(now - 300)
      .run();
    expect(await count("track_totals", "user_id = 1")).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(4);

    const response = await post("/settings/sources/remove", { id: "11" });
    expect(response.status).toBe(303);
    expect(await count("plays", "source_id = 11")).toBe(0);
    expect(await count("sources", "id = 11")).toBe(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM track_totals WHERE user_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(3);
    expect(
      (
        await env.DB.prepare(
          "SELECT plays FROM artist_totals WHERE user_id = 1",
        ).first<{ plays: number }>()
      )?.plays,
    ).toBe(3);
    expect(
      (
        await env.DB.prepare(
          "SELECT SUM(plays) AS s FROM daily_totals WHERE user_id = 1",
        ).first<{ s: number }>()
      )?.s,
    ).toBe(3);
  });

  it("source removal reads only the owner's plays", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1000, 'alice', ?1), (2, 2000, 'bob', ?1)",
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'spotify-user'), (20, 2, 'spotify', 'bob')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttrack', 1, 'Track')",
    ).run();
    for (let i = 0; i < 3; i += 1) {
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, 10, ?2, 1)",
      )
        .bind(now - i * 60, `r${i}`)
        .run();
    }
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 2, ?1 - x, 20, 'b' || x, 1 FROM n`,
    )
      .bind(now)
      .run();

    const db = database(env.DB);
    const results = await db.batch(sourceRemovalStatements(db, 1, 10));
    expect(results[0]?.meta.rows_read).toBeLessThan(1000);
    expect(await count("plays", "user_id = 2")).toBe(1000);
    expect(await count("plays", "user_id = 1")).toBe(0);
  });
});

describe("upload tokens", () => {
  it("issues a token once and revokes it", async () => {
    await seedUser();
    const response = await post("/settings/tokens", { kind: "ytmusic" });
    expect(response.status).toBe(303);
    const issued = /__Host-issued-token=([^;]*)/.exec(
      response.headers.get("set-cookie") ?? "",
    )?.[1];
    const shown = /msu_[A-Za-z0-9_-]{43}/.exec(issued ?? "")?.[0];
    expect(shown).toBeTruthy();
    const flashed = await get("/settings", {
      cookie: `__Host-session=${session}; __Host-issued-token=${issued}`,
    });
    expect((await read(flashed)).inputs).toContainEqual({
      label: "New upload token",
      value: shown,
    });
    const source = await env.DB.prepare(
      "SELECT id FROM sources WHERE user_id = 1 AND kind = 'ytmusic'",
    ).first<{ id: number }>();
    const token = await env.DB.prepare(
      "SELECT hash, hint FROM tokens WHERE source_id = ?1",
    )
      .bind(source?.id)
      .first<{ hash: Uint8Array; hint: string }>();
    expect(token?.hint).toBe(shown?.slice(-4));
    expect(new Uint8Array(token?.hash ?? [])).toEqual(await sha256(shown!));

    // Shown once: nowhere in the next response, scripts included.
    const followUp = await (await get("/settings")).text();
    expect(followUp).not.toContain(shown!);

    await post("/settings/tokens/revoke", { id: "1" });
    const revoked = await env.DB.prepare(
      "SELECT revoked_at FROM tokens WHERE id = 1",
    ).first<{ revoked_at: number | null }>();
    expect(revoked?.revoked_at).not.toBeNull();

    const upload = await app.fetch(
      new Request(`${origin}/api/v1/upload`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${shown}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ plays: [] }),
      }),
      testEnv() as never,
    );
    expect(upload.status).toBe(401);
  });
});

describe("scrobbler tokens", () => {
  it("issues a token against a listenbrainz source and revokes it", async () => {
    await seedUser();
    const response = await post("/settings/tokens", { kind: "listenbrainz" });
    expect(response.status).toBe(303);
    const cookies = response.headers.get("set-cookie") ?? "";
    const issued = /__Host-issued-token=([^;]*)/.exec(cookies)?.[1];
    const shown = /msu_[A-Za-z0-9_-]{43}/.exec(issued ?? "")?.[0];
    expect(shown).toBeTruthy();
    expect(cookies).toContain("__Host-issued-token-kind=listenbrainz");

    const source = await env.DB.prepare(
      "SELECT id FROM sources WHERE user_id = 1 AND kind = 'listenbrainz'",
    ).first<{ id: number }>();
    expect(source).not.toBeNull();
    const stored = await env.DB.prepare(
      "SELECT hash, hint FROM tokens WHERE source_id = ?1",
    )
      .bind(source?.id)
      .first<{ hash: Uint8Array; hint: string }>();
    expect(stored?.hint).toBe(shown?.slice(-4));
    expect(new Uint8Array(stored?.hash ?? [])).toEqual(await sha256(shown!));

    const page = await get("/settings", {
      cookie: `__Host-session=${session}; __Host-issued-token=${issued}; __Host-issued-token-kind=listenbrainz`,
    });
    expect((await read(page)).inputs).toContainEqual({
      label: "New scrobbler token",
      value: shown,
    });

    const valid = await app.fetch(
      new Request(`${origin}/1/validate-token`, {
        headers: { authorization: `Token ${shown}` },
      }),
      testEnv() as never,
    );
    expect((await valid.json<{ valid: boolean }>()).valid).toBe(true);

    const tokenRow = await env.DB.prepare(
      "SELECT id FROM tokens WHERE source_id = ?1",
    )
      .bind(source?.id)
      .first<{ id: number }>();
    await post("/settings/tokens/revoke", { id: String(tokenRow?.id) });
    const revoked = await app.fetch(
      new Request(`${origin}/1/validate-token`, {
        headers: { authorization: `Token ${shown}` },
      }),
      testEnv() as never,
    );
    expect(revoked.status).toBe(401);
  });

  it("removing the source deletes its plays and tokens", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind) VALUES (12, 1, 'listenbrainz')",
    ).run();
    await seedPlays(1, 12);
    await env.DB.prepare(
      "INSERT INTO tokens (source_id, hash, hint, created_at) VALUES (12, ?1, 'abcd', ?2)",
    )
      .bind(await sha256("msu_x"), now)
      .run();

    const response = await post("/settings/sources/remove", { id: "12" });
    expect(response.status).toBe(303);
    expect(await count("plays", "source_id = 12")).toBe(0);
    expect(await count("sources", "id = 12")).toBe(0);
    expect(await count("tokens")).toBe(0);
  });
});

describe("export", () => {
  it("pages follow the next link to every play", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'spotify-user')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttrack', 1, 'Track')",
    ).run();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2500)
       INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       SELECT 1, ?1 - x, 10, 'ref,with,' || x, 1 FROM n`,
    )
      .bind(now)
      .run();

    let url: string | undefined = "/settings/export";
    const keys: string[] = [];
    let responses = 0;
    while (url !== undefined) {
      const response = await get(url);
      responses += 1;
      const body = await response.text();
      for (const line of body.trim().split("\n")) {
        const play = JSON.parse(line) as {
          played_at: number;
          source: string;
          ref: string;
        };
        keys.push(`${play.played_at}${play.source}${play.ref}`);
      }
      const link = /<([^>]+)>;\s*rel="next"/.exec(
        response.headers.get("link") ?? "",
      );
      url = link?.[1];
    }
    expect(responses).toBe(3);
    expect(keys.length).toBe(2500);
    expect(new Set(keys).size).toBe(2500);
    expect(keys[0]!.includes("ref,with,2500")).toBe(true);
    expect([...keys].sort().every((key, i) => key === keys[i])).toBe(true);
  });

  it("rejects a malformed after key and ships the export script", async () => {
    await seedUser();
    expect((await get("/settings/export?after=x,y,z")).status).toBe(400);
    // Without JavaScript the link downloads the first page; the export script
    // takes the click over through the link's id.
    const page = await read(await get("/settings"));
    const download = linkTo(page, "/settings/export");
    expect(download?.label).toBe("Download your plays");
    expect(page.ids).toContain("export-all");
  });

  it("streams every play as NDJSON", async () => {
    await seedUser();
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'spotify-user')",
    ).run();
    await seedPlays();
    const response = await get("/settings/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("x-ndjson");
    const lines = (await response.text()).trim().split("\n");
    expect(lines).toHaveLength(3);
    const play = JSON.parse(lines[0]!);
    expect(play).toEqual({
      played_at: expect.any(Number),
      source: "spotify",
      ref: expect.any(String),
      artist: "Artist",
      title: "Track",
    });
  });
});

describe("deletion", () => {
  it("requires the typed name", async () => {
    await seedUser();
    const response = await post("/settings/delete", { confirm: "nope" });
    expect(response.status).toBe(400);
    expect(await count("users")).toBe(1);
  });

  it("removes a group the deleted account leaves empty, and keeps one with members", async () => {
    await seedUser();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, github_id, name, created_at) VALUES (2, 2000, 'bob', ?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO friend_groups (id, name, creator_id, created_at) VALUES (1, 'only alice', 2, ?1), (2, 'both', 2, ?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO group_members (group_id, user_id, created_at) VALUES (1, 1, ?1), (2, 1, ?1), (2, 2, ?1)",
      ).bind(now),
    ]);
    expect((await post("/settings/delete", { confirm: "alice" })).status).toBe(
      303,
    );
    const groups = await env.DB.prepare("SELECT name FROM friend_groups").all<{
      name: string;
    }>();
    expect(groups.results).toEqual([{ name: "both" }]);
  });

  it("a new person signs in, connects a source, and deletes the account, and no row of theirs remains", async () => {
    network.use(
      http.post("https://github.com/login/oauth/access_token", () =>
        HttpResponse.json({ access_token: "t" }),
      ),
      http.get("https://api.github.com/user", () =>
        HttpResponse.json({ id: 77, login: "NewPerson" }),
      ),
    );
    const beginResponse = await app.fetch(
      new Request(`${origin}/auth/github`),
      testEnv() as never,
    );
    const state = new URL(
      beginResponse.headers.get("location") ?? "",
    ).searchParams.get("state");
    const callback = await app.fetch(
      new Request(`${origin}/auth/github/callback?code=c&state=${state}`, {
        headers: { cookie: `__Host-oauth-state=${state}` },
      }),
      testEnv() as never,
    );
    expect(callback.status).toBe(303);
    const cookie =
      /__Host-session=([^;]*)/.exec(
        callback.headers.get("set-cookie") ?? "",
      )?.[1] ?? "";
    const authed = (path: string, fields: Record<string, string>) =>
      app.fetch(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: {
            cookie: `__Host-session=${cookie}`,
            "content-type": "application/x-www-form-urlencoded",
            origin,
          },
          body: new URLSearchParams(fields).toString(),
        }),
        testEnv() as never,
      );
    await env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account) VALUES (10, 1, 'spotify', 'newperson-sp')",
    ).run();
    await authed("/settings/tokens", {});
    await env.DB.prepare(
      "INSERT INTO artists (id, key, name) VALUES (1, 'artist', 'Artist')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO tracks (id, key, artist_id, title) VALUES (1, 'artisttrack', 1, 'Track')",
    ).run();
    const source = await env.DB.prepare(
      "SELECT id FROM sources WHERE kind = 'spotify'",
    ).first<{ id: number }>();
    for (let i = 0; i < 5; i += 1) {
      await env.DB.prepare(
        "INSERT INTO plays (user_id, played_at, source_id, ref, track_id) VALUES (1, ?1, ?2, ?3, 1)",
      )
        .bind(now - i * 60, source?.id, `r${i}`)
        .run();
    }
    expect(
      (await authed("/settings/delete", { confirm: "newperson" })).status,
    ).toBe(303);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    for (const { name } of tables.results) {
      const columns = await env.DB.prepare(
        "SELECT name FROM pragma_table_info(?1)",
      )
        .bind(name)
        .all<{ name: string }>();
      if (columns.results.some((column) => column.name === "user_id")) {
        expect(await count(name, "user_id = 1"), name).toBe(0);
      }
    }
    expect(await count("users", "id = 1"), "users").toBe(0);
    expect(await count("tokens"), "tokens").toBe(0);
  });
});
