import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import migrations from "virtual:web-migrations";
import { app } from "../src/app";

const now = Math.floor(Date.now() / 1000);
const origin = "https://earshot.rising.sh";

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
});

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUser(id: number, name: string, isPublic = 1) {
  await env.DB.prepare(
    `INSERT INTO users (id, github_id, name, is_public, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, id * 1000, name, isPublic, now)
    .run();
  const session = `sess_${name}_${"s".repeat(30)}`;
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
  )
    .bind(await sha256(session), id, now + 30 * 86400)
    .run();
  return session;
}

function request(
  path: string,
  session: string | null,
  options: { method?: string; fields?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { origin };
  if (session !== null) headers.cookie = `__Host-session=${session}`;
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: options.method ?? (options.fields ? "POST" : "GET"),
      headers: {
        ...headers,
        ...(options.fields
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: options.fields
        ? new URLSearchParams(options.fields).toString()
        : undefined,
    }),
    testEnv() as never,
  );
}

const get = (path: string, session: string | null) => request(path, session);
const post = (
  path: string,
  session: string | null,
  fields: Record<string, string>,
) => request(path, session, { method: "POST", fields });

async function count(table: string, where = "1 = 1") {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

async function seedPlays(userId: number, sourceId: number, trackIds: number[]) {
  await env.DB.prepare(
    "INSERT INTO sources (id, user_id, kind) VALUES (?1, ?2, 'spotify')",
  )
    .bind(sourceId, userId)
    .run();
  for (const [index, trackId] of trackIds.entries()) {
    await env.DB.prepare(
      `INSERT INTO plays (user_id, played_at, source_id, ref, track_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(userId, now - 3600 * (index + 1), sourceId, `r${trackId}`, trackId)
      .run();
  }
}

async function seedTracks(n: number, artists = n) {
  const artistRows = Array.from(
    { length: artists },
    (_, i) => `(${i + 1}, 'art${i + 1}', 'Artist ${i + 1}')`,
  ).join(", ");
  await env.DB.prepare(
    `INSERT INTO artists (id, key, name) VALUES ${artistRows}`,
  ).run();
  const trackRows = Array.from(
    { length: n },
    (_, i) =>
      `(${i + 1}, 'trk${i + 1}', ${(i % artists) + 1}, 'Song ${i + 1}')`,
  ).join(", ");
  await env.DB.prepare(
    `INSERT INTO tracks (id, key, artist_id, title) VALUES ${trackRows}`,
  ).run();
}

async function makeFriends(a: number, b: number) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)",
    ).bind(a, b, now),
    env.DB.prepare(
      "INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)",
    ).bind(b, a, now),
  ]);
}

async function friendLink(userId: number) {
  const row = await env.DB.prepare(
    "SELECT friend_link FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ friend_link: string | null }>();
  return row?.friend_link ?? null;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});

describe("the friend link", () => {
  it("shows the link on /friends and makes friends on one POST", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    const page = await get("/friends", alice);
    expect(page.status).toBe(200);
    const link = await friendLink(1);
    expect(link).not.toBeNull();
    expect(await page.text()).toContain(`/friends/add/${link}`);

    const confirm = await get(`/friends/add/${link}`, bob);
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("alice");
    expect(confirmHtml).toContain('method="post"');

    const added = await post(`/friends/add/${link}`, bob, {});
    expect(added.status).toBe(303);
    expect(await count("friendships", "user_id = 1 AND friend_id = 2")).toBe(1);
    expect(await count("friendships", "user_id = 2 AND friend_id = 1")).toBe(1);
  });

  it("stops the old link after a reset", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await get("/friends", alice);
    const oldLink = await friendLink(1);
    const resetResponse = await post("/friends/link/reset", alice, {});
    expect(resetResponse.status).toBe(303);
    const newLink = await friendLink(1);
    expect(newLink).not.toBe(oldLink);
    expect((await get(`/friends/add/${oldLink}`, bob)).status).toBe(404);
    expect((await get(`/friends/add/${newLink}`, bob)).status).toBe(200);
  });

  it("shows one canonical link to repeat first visits", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    const one = await get("/friends", alice);
    const two = await get("/friends", alice);
    const link = await friendLink(1);
    for (const page of [one, two])
      expect(await page.text()).toContain(`/friends/add/${link}`);
    const confirm = await get(`/friends/add/${link}`, bob);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("alice");
  });

  it("refuses your own link and repeats for existing friends", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await get("/friends", alice);
    const link = await friendLink(1);
    const own = await get(`/friends/add/${link}`, alice);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("your own friend link");
    await makeFriends(1, 2);
    const again = await get(`/friends/add/${link}`, bob);
    expect(await again.text()).toContain("already friends");
  });
});

describe("friend requests", () => {
  it("sends a request the addressee can accept", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    const sent = await post("/friends/request", alice, { name: "bob" });
    expect(await sent.text()).toContain("Request sent to bob.");
    const request = await env.DB.prepare(
      "SELECT id FROM friend_requests WHERE from_user = 1 AND to_user = 2",
    ).first<{ id: number }>();
    expect(request).not.toBeNull();

    const bobsPage = await get("/friends", bob);
    expect(await bobsPage.text()).toContain("alice");

    const accept = await post("/friends/requests/accept", bob, {
      id: String(request!.id),
    });
    expect(accept.status).toBe(303);
    expect(await count("friendships")).toBe(2);
    expect(await count("friend_requests")).toBe(0);
  });

  it("lets the addressee decline and the sender cancel", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await seedUser(3, "carol");
    await post("/friends/request", alice, { name: "bob" });
    await post("/friends/request", alice, { name: "carol" });
    const rows = await env.DB.prepare(
      "SELECT id, to_user FROM friend_requests ORDER BY id",
    ).all<{ id: number; to_user: number }>();
    const [toBob, toCarol] = rows.results;

    const decline = await post("/friends/requests/decline", bob, {
      id: String(toBob!.id),
    });
    expect(decline.status).toBe(303);
    const cancel = await post("/friends/requests/cancel", alice, {
      id: String(toCarol!.id),
    });
    expect(cancel.status).toBe(303);
    expect(await count("friend_requests")).toBe(0);
    expect(await count("friendships")).toBe(0);
  });

  it("answers a hidden and a missing name the same way", async () => {
    const alice = await seedUser(1, "alice");
    await seedUser(3, "carol", 0);
    const hidden = await post("/friends/request", alice, { name: "carol" });
    const missing = await post("/friends/request", alice, { name: "nobody" });
    expect(await hidden.text()).toContain("Request sent to carol.");
    expect(await missing.text()).toContain("Request sent to nobody.");
    expect(
      await count("friend_requests", "from_user = 1 AND to_user = 3"),
    ).toBe(1);
    expect(await count("friend_requests")).toBe(1);
  });

  it("refuses a request above the pending cap", async () => {
    const alice = await seedUser(1, "alice");
    await seedUser(2, "bob");
    const users = Array.from(
      { length: 20 },
      (_, i) => `(${100 + i}, ${(100 + i) * 1000}, 'user-${i}', ${now})`,
    ).join(", ");
    await env.DB.prepare(
      `INSERT INTO users (id, github_id, name, created_at) VALUES ${users}`,
    ).run();
    const rows = Array.from(
      { length: 20 },
      (_, i) => `(1, ${100 + i}, ${now})`,
    ).join(", ");
    await env.DB.prepare(
      `INSERT INTO friend_requests (from_user, to_user, created_at)
       VALUES ${rows}`,
    ).run();
    const response = await post("/friends/request", alice, { name: "bob" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("20 requests waiting");
  });

  it("lets only one of two back-to-back requests pass the cap", async () => {
    const alice = await seedUser(1, "alice");
    await seedUser(2, "bob");
    await seedUser(3, "carol");
    const users = Array.from(
      { length: 19 },
      (_, i) => `(${100 + i}, ${(100 + i) * 1000}, 'user-${i}', ${now})`,
    ).join(", ");
    await env.DB.prepare(
      `INSERT INTO users (id, github_id, name, created_at) VALUES ${users}`,
    ).run();
    const rows = Array.from(
      { length: 19 },
      (_, i) => `(1, ${100 + i}, ${now})`,
    ).join(", ");
    await env.DB.prepare(
      `INSERT INTO friend_requests (from_user, to_user, created_at)
       VALUES ${rows}`,
    ).run();
    const first = await post("/friends/request", alice, { name: "bob" });
    const second = await post("/friends/request", alice, { name: "carol" });
    const bodies = [await first.text(), await second.text()];
    expect(
      bodies.filter((body) => body.includes("20 requests waiting")),
    ).toHaveLength(1);
    expect(await count("friend_requests", "from_user = 1")).toBe(20);
  });

  it("accepts a request sent back to someone who already asked", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await post("/friends/request", bob, { name: "alice" });
    const reply = await post("/friends/request", alice, { name: "bob" });
    expect(await reply.text()).toContain("friends now");
    expect(await count("friendships")).toBe(2);
    expect(await count("friend_requests")).toBe(0);
  });

  it("refuses an accept by anyone but the addressee", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    const eve = await seedUser(4, "eve");
    await post("/friends/request", alice, { name: "bob" });
    const request = await env.DB.prepare(
      "SELECT id FROM friend_requests WHERE to_user = 2",
    ).first<{ id: number }>();
    for (const [session, route] of [
      [eve, "/friends/requests/accept"],
      [eve, "/friends/requests/decline"],
      [alice, "/friends/requests/decline"],
      [bob, "/friends/requests/cancel"],
    ] as const) {
      const response = await post(route, session, {
        id: String(request!.id),
      });
      expect(response.status).toBe(400);
    }
    expect(await count("friend_requests")).toBe(1);
    expect(await count("friendships")).toBe(0);
  });

  it("removes a friend in both directions", async () => {
    const alice = await seedUser(1, "alice");
    await seedUser(2, "bob");
    await makeFriends(1, 2);
    const removed = await post("/friends/remove", alice, { id: "2" });
    expect(removed.status).toBe(303);
    expect(await count("friendships")).toBe(0);
    const repeat = await post("/friends/remove", alice, { id: "2" });
    expect(repeat.status).toBe(400);
  });
});

describe("groups", () => {
  async function seedGroup() {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await makeFriends(1, 2);
    const created = await post("/groups", alice, { name: "Kitchen" });
    expect(created.status).toBe(303);
    const location = created.headers.get("location") ?? "";
    return { alice, bob, groupPath: location };
  }

  it("creates a group and lists it on /groups", async () => {
    const { alice, groupPath } = await seedGroup();
    expect(groupPath).toBe("/groups/1");
    const list = await get("/groups", alice);
    const html = await list.text();
    expect(html).toContain("Kitchen");
    expect(html).toContain("1 member");
  });

  it("adds picked friends on create and refuses a non-friend id", async () => {
    const alice = await seedUser(1, "alice");
    await seedUser(2, "bob");
    await seedUser(3, "carol");
    await makeFriends(1, 2);
    const created = await post("/groups", alice, {
      name: "Kitchen",
      member: "2",
    });
    expect(created.status).toBe(303);
    expect(await count("group_members", "group_id = 1")).toBe(2);
    const refused = await post("/groups", alice, {
      name: "Sneaky",
      member: "3",
    });
    expect(refused.status).toBe(403);
    expect(await count("friend_groups")).toBe(1);
  });

  it("answers 404 for non-members and explains itself signed out", async () => {
    const { groupPath } = await seedGroup();
    const eve = await seedUser(4, "eve");
    expect((await get(groupPath, eve)).status).toBe(404);
    expect((await get("/groups/99", eve)).status).toBe(404);
    const out = await get("/groups", null);
    const html = await out.text();
    expect(out.status).toBe(200);
    expect(html).toContain("Sign in");
    const friends = await get("/friends", null);
    expect(friends.status).toBe(200);
    expect(await friends.text()).toContain("Sign in");
  });

  it("lets a member add their own friend, and refuses anyone else", async () => {
    const { alice, bob, groupPath } = await seedGroup();
    await seedUser(3, "carol");
    const eve = await seedUser(4, "eve");
    await makeFriends(2, 3);
    await post(`${groupPath}/members`, alice, { user: "2" });
    const added = await post(`${groupPath}/members`, bob, { user: "3" });
    expect(added.status).toBe(303);
    expect(await count("group_members", "group_id = 1 AND user_id = 3")).toBe(
      1,
    );

    // eve is nobody's friend and not a member: she gets 404 on the group.
    expect(
      (await post(`${groupPath}/members`, eve, { user: "3" })).status,
    ).toBe(404);
    // alice is a member but eve is not her friend.
    expect(
      (await post(`${groupPath}/members`, alice, { user: "4" })).status,
    ).toBe(403);
  });

  it("lets the creator rename and refuses another member", async () => {
    const { alice, bob, groupPath } = await seedGroup();
    await post(`${groupPath}/members`, alice, { user: "2" });
    const renamed = await post(`${groupPath}/rename`, alice, {
      name: "Porch",
    });
    expect(renamed.status).toBe(303);
    expect(
      (await post(`${groupPath}/rename`, bob, { name: "Nope" })).status,
    ).toBe(403);
    const page = await get(groupPath, alice);
    expect(await page.text()).toContain("Porch");
  });

  it("deletes the group when the last member leaves", async () => {
    const { alice, bob, groupPath } = await seedGroup();
    await post(`${groupPath}/members`, alice, { user: "2" });
    expect((await post(`${groupPath}/leave`, bob, {})).status).toBe(303);
    expect(await count("friend_groups")).toBe(1);
    expect((await post(`${groupPath}/leave`, alice, {})).status).toBe(303);
    expect(await count("friend_groups")).toBe(0);
  });

  it("blends member plays, including a hidden member's", async () => {
    await seedTracks(6, 3);
    const alice = await seedUser(1, "alice");
    await seedUser(2, "bob");
    await seedUser(3, "carol", 0);
    await makeFriends(1, 2);
    await makeFriends(1, 3);
    await seedPlays(1, 10, [1, 2]);
    await seedPlays(2, 20, [1, 3]);
    await seedPlays(3, 30, [4, 5]);
    await env.DB.prepare(
      `INSERT INTO track_aliases (kind, source_key, track_id) VALUES
       ('ytmusic', 'vid-one', 1), ('ytmusic', 'vid-two', 2)`,
    ).run();

    const created = await post("/groups", alice, { name: "Kitchen" });
    const groupPath = created.headers.get("location") ?? "";
    await post(`${groupPath}/members`, alice, { user: "2" });
    await post(`${groupPath}/members`, alice, { user: "3" });

    const page = await get(groupPath, alice);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Play on YouTube");
    expect(html).toContain("watch_videos?video_ids=vid-one,vid-two");
    // Song 4 and 5 are carol's; her hidden profile still feeds the group.
    expect(html).toContain("Song 4");
    expect(html).toContain("carol");
    // Her profile page stays hidden.
    const profile = await get("/u/carol", alice);
    expect(profile.status).toBe(404);
  });
});

describe("the profile footer", () => {
  it("shows the friend state to a signed-in visitor", async () => {
    const alice = await seedUser(1, "alice");
    const bob = await seedUser(2, "bob");
    await seedTracks(1);
    await seedPlays(2, 20, [1]);

    const none = await get("/u/bob", alice);
    expect((await none.text()).match(/Add friend/)).not.toBeNull();

    await post("/friends/request", alice, { name: "bob" });
    const sent = await get("/u/bob", alice);
    expect(await sent.text()).toContain("Request sent");

    await makeFriends(1, 2);
    const friends = await get("/u/bob", alice);
    const html = await friends.text();
    expect(html).toContain('href="/friends"');
    expect(html).not.toContain("Add friend");

    // The viewer's own profile carries no friend action.
    const own = await get("/u/bob", bob);
    const ownHtml = await own.text();
    expect(ownHtml).not.toContain("Add friend");
    expect(ownHtml).not.toContain("Request sent");
  });
});

describe("/party", () => {
  it.each(["/party", "/party?u=alice,bob&n=25"])(
    "redirects %s to /groups",
    async (path) => {
      const response = await app.fetch(
        new Request(`${origin}${path}`, { redirect: "manual" }),
        testEnv() as never,
      );
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/groups");
    },
  );
});
