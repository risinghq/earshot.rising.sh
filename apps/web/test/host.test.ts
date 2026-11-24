import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readPage, textAt } from "./html";

const oldOrigin = "https://music.rising.sh";
const newOrigin = "https://earshot.rising.sh";
const now = Math.floor(Date.now() / 1000);

async function seedUser() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, github_id, name, created_at) VALUES (1, 1, 'alice', ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sources (id, user_id, kind, account, next_pull_at) VALUES (10, 1, 'spotify', 'alice-sp', ?1)",
    ).bind(now),
  ]);
}

describe("the old host", () => {
  it.each([
    [
      "GET",
      `${oldOrigin}/u/alice?period=month`,
      `${newOrigin}/u/alice?period=month`,
    ],
    ["GET", `${oldOrigin}/party?u=alice,bob`, `${newOrigin}/party?u=alice,bob`],
    ["HEAD", `${oldOrigin}/u/alice`, `${newOrigin}/u/alice`],
  ])(
    "answers a %s page request with 301 to the same path and query on earshot",
    async (method, url, location) => {
      const response = await SELF.fetch(
        new Request(url, { method, redirect: "manual" }),
      );
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(location);
    },
  );

  it("posts an upload without a redirect", async () => {
    const response = await SELF.fetch(
      new Request(`${oldOrigin}/api/v1/upload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plays: [] }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("serves the card and the profile JSON without a redirect", async () => {
    await seedUser();
    const card = await SELF.fetch(`${oldOrigin}/u/alice.svg`);
    expect(card.status).toBe(200);
    expect(card.headers.get("content-type")).toBe("image/svg+xml");
    const json = await SELF.fetch(`${oldOrigin}/u/alice.json`);
    expect(json.status).toBe(200);
  });

  it("answers the scrobbler and sign-in routes without a redirect", async () => {
    const validate = await SELF.fetch(`${oldOrigin}/1/validate-token`);
    expect(validate.status).toBe(401);
    const callback = await SELF.fetch(
      new Request(`${oldOrigin}/auth/github/callback`, {
        redirect: "manual",
      }),
    );
    expect(callback.status).not.toBe(301);
    expect(callback.headers.get("location") ?? "").not.toContain(newOrigin);
  });

  it("passes a WebSocket upgrade through", async () => {
    const response = await SELF.fetch(
      new Request(`${oldOrigin}/play/match/chart/ws`, {
        headers: { upgrade: "websocket" },
      }),
    );
    expect(response.status).not.toBe(301);
  });
});

describe("the new host", () => {
  it("serves pages directly, titled Earshot", async () => {
    await seedUser();
    const response = await SELF.fetch(`${newOrigin}/u/alice`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(await textAt(html, "title")).toEqual(["alice · Earshot"]);
    const page = await readPage(html, newOrigin);
    expect(
      page.links.find((link) => link.href === `${newOrigin}/`)?.label,
    ).toBe("Earshot");
  });
});
