import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { clipUrl, roundClip } from "../src/play/game/clip";
import type { Env } from "../src/env";
import { deezerTracks, network } from "./network";

const origin = "https://earshot.rising.sh";
const now = Math.floor(Date.now() / 1000);
const session = `sess_${"s".repeat(40)}`;
const webhookSecret = `whsec_${btoa("w".repeat(32))}`;
const clipKey = btoa("a".repeat(32));

const testEnv = (extra: Record<string, string> = {}) =>
  ({
    DB: env.DB,
    CACHE: env.CACHE,
    POLAR_WEBHOOK_SECRET: webhookSecret,
    POLAR_CHECKOUT_LINK: "https://polar.sh/test_link",
    SOURCE_ENCRYPTION_KEY: clipKey,
    ADMIN_GITHUB_IDS: "42",
    ...extra,
  }) as unknown as Env;

async function sha256(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function seedUser(userId = 1, githubId = 1000, withSession = true) {
  await env.DB.prepare(
    "INSERT INTO users (id, github_id, name, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(userId, githubId, `user${userId}`, now)
    .run();
  if (withSession)
    await env.DB.prepare(
      "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
    )
      .bind(await sha256(session), userId, now + 30 * 86400)
      .run();
}

const tierOf = async (userId: number) =>
  (
    await env.DB.prepare("SELECT tier FROM users WHERE id = ?1")
      .bind(userId)
      .first<{ tier: string }>()
  )?.tier;

const b64 = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

const webhookId = "msg_test";

async function polarPost(body: string, sign = true) {
  const stamp = now;
  const keyBytes = Uint8Array.from(atob(webhookSecret.slice(6)), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const v1 = b64(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${webhookId}.${stamp}.${body}`),
    ),
  );
  return app.fetch(
    new Request(`${origin}/billing/webhook`, {
      method: "POST",
      headers: sign
        ? {
            "webhook-id": webhookId,
            "webhook-timestamp": String(stamp),
            "webhook-signature": `v1,${v1}`,
          }
        : {},
      body,
    }),
    testEnv(),
  );
}

const orderEvent = (type: string, referenceId: string) =>
  JSON.stringify({
    type,
    data: {
      customer: { external_id: null },
      metadata: { reference_id: referenceId },
    },
  });
const paidEvent = (referenceId: string) =>
  orderEvent("order.paid", referenceId);

describe("polar webhook", () => {
  it("marks the referenced user paid on order.paid", async () => {
    await seedUser();
    const response = await polarPost(paidEvent("1"));
    expect(response.status).toBe(200);
    expect(await tierOf(1)).toBe("paid");
  });

  it("refuses an unsigned body", async () => {
    await seedUser();
    const response = await polarPost(paidEvent("1"), false);
    expect(response.status).toBe(403);
    expect(await tierOf(1)).toBe("free");
  });

  it("refuses a wrong signature", async () => {
    await seedUser();
    const response = await app.fetch(
      new Request(`${origin}/billing/webhook`, {
        method: "POST",
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(now),
          "webhook-signature": "v1,deadbeef",
        },
        body: paidEvent("1"),
      }),
      testEnv(),
    );
    expect(response.status).toBe(403);
    expect(await tierOf(1)).toBe("free");
  });

  it("acknowledges an order without a reference and changes nothing", async () => {
    await seedUser();
    const response = await polarPost(
      JSON.stringify({ type: "order.paid", data: { metadata: {} } }),
    );
    expect(response.status).toBe(200);
    expect(await tierOf(1)).toBe("free");
  });

  it("revokes the tier on order.refunded", async () => {
    await seedUser();
    expect((await polarPost(paidEvent("1"))).status).toBe(200);
    expect(await tierOf(1)).toBe("paid");
    const refund = await polarPost(orderEvent("order.refunded", "1"));
    expect(refund.status).toBe(200);
    expect(await tierOf(1)).toBe("free");
  });

  it("ignores events that are not orders", async () => {
    await seedUser();
    const response = await polarPost(orderEvent("checkout.updated", "1"));
    expect(response.status).toBe(200);
    expect(await tierOf(1)).toBe("free");
  });
});

describe("admin tier grant", () => {
  it("lets an admin grant and revoke the paid tier", async () => {
    await seedUser(1, 42);
    await seedUser(2, 2000, false);
    const post = async (tier: string) =>
      app.fetch(
        new Request(`${origin}/admin/users/2/tier`, {
          method: "POST",
          headers: { cookie: `__Host-session=${session}`, origin },
          body: new URLSearchParams({ tier }),
        }),
        testEnv(),
      );
    expect((await post("paid")).status).toBe(303);
    expect(await tierOf(2)).toBe("paid");
    expect((await post("free")).status).toBe(303);
    expect(await tierOf(2)).toBe("free");
  });

  it("refuses a non-admin", async () => {
    await seedUser(1, 1000);
    await seedUser(2, 2000, false);
    const response = await app.fetch(
      new Request(`${origin}/admin/users/2/tier`, {
        method: "POST",
        headers: { cookie: `__Host-session=${session}`, origin },
        body: new URLSearchParams({ tier: "paid" }),
      }),
      testEnv(),
    );
    expect(response.status).not.toBe(303);
    expect(await tierOf(2)).toBe("free");
  });
});

describe("settings tier block", () => {
  it("shows the purchase link carrying the user id", async () => {
    await seedUser();
    const response = await app.fetch(
      new Request(`${origin}/settings`, {
        headers: { cookie: `__Host-session=${session}`, origin },
      }),
      testEnv(),
    );
    const html = await response.text();
    expect(html).toContain("Get Earshot+");
    expect(html).toContain("test_link?reference_id=1");
  });

  it("shows the supporter badge to a paid user", async () => {
    await seedUser();
    await env.DB.prepare("UPDATE users SET tier = 'paid' WHERE id = 1").run();
    const response = await app.fetch(
      new Request(`${origin}/settings`, {
        headers: { cookie: `__Host-session=${session}`, origin },
      }),
      testEnv(),
    );
    const html = await response.text();
    expect(html).toContain("Supporter");
    expect(html).not.toContain("Get Earshot+");
  });
});

describe("intro clip resolution", () => {
  const candidate = {
    title: "Song",
    artist: "Artist",
    cover: "https://cdn.example/c.jpg",
    link: "https://www.deezer.com/track/42",
    deezerId: 42,
  };
  const works: Promise<unknown>[] = [];
  const collect = (work: Promise<unknown>) => works.push(work);

  it("serves the cached clip URL without a Deezer lookup", async () => {
    await env.CACHE.put("antra:track:42", "mp3");
    await env.CACHE.put("antra:ready:42", "1");
    const preview = await roundClip(
      {
        DB: env.DB,
        CACHE: env.CACHE,
        SOURCE_ENCRYPTION_KEY: clipKey,
      } as unknown as Env,
      candidate,
      "intro",
      collect,
    );
    expect(preview?.url).toMatch(/^\/play\/clip\/42\?k=.+#t=0,10$/);
    expect(works).toHaveLength(0);
  });

  it("checks the ready marker, never the mp3, on a warm round", async () => {
    await env.CACHE.put("antra:track:42", "mp3");
    await env.CACHE.put("antra:ready:42", "1");
    const get = vi.spyOn(env.CACHE, "get");
    const preview = await roundClip(
      {
        DB: env.DB,
        CACHE: env.CACHE,
        SOURCE_ENCRYPTION_KEY: clipKey,
      } as unknown as Env,
      candidate,
      "intro",
      collect,
    );
    expect(preview?.url).toContain("/play/clip/42");
    expect(get.mock.calls.map(([key]) => key)).not.toContain("antra:track:42");
  });

  it("serves the preview on a cold cache and warms in the background", async () => {
    works.length = 0;
    network.use(deezerTracks());
    const preview = await roundClip(
      {
        DB: env.DB,
        CACHE: env.CACHE,
        SOURCE_ENCRYPTION_KEY: clipKey,
      } as unknown as Env,
      candidate,
      "intro",
      collect,
    );
    expect(preview?.url).toBe("https://cdn.example/42.mp3");
    expect(works).toHaveLength(1);
    await works.pop();
    // The warm fails without antra configured; nothing is cached, so a paid
    // round keeps playing the preview instead of hard-failing, and the
    // claim is released so the next serve retries.
    expect(await env.CACHE.get("antra:track:42")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT deezer_id FROM warm_claims WHERE deezer_id = 42",
      ).first(),
    ).toBeNull();
  });

  it("submits one antra job across concurrent cold serves", async () => {
    works.length = 0;
    const base = "https://antra.test";
    let jobs = 0;
    network.use(
      deezerTracks(),
      http.post(`${base}/api/auth/login`, () =>
        HttpResponse.json({}, { headers: { "set-cookie": "s=x" } }),
      ),
      http.post(`${base}/api/jobs`, () => {
        jobs += 1;
        return HttpResponse.json({ job_id: "j1" });
      }),
      http.get(`${base}/api/jobs/j1/status`, () =>
        HttpResponse.json({
          status: "done",
          done: 1,
          total: 1,
          filename: "x.mp3",
          error: null,
        }),
      ),
      http.get(`${base}/api/jobs/j1/tracks/0/download`, () =>
        HttpResponse.text("mp3bytes"),
      ),
      http.post(
        `${base}/api/jobs/j1/tracks/0/ack`,
        () => new HttpResponse(null),
      ),
    );
    const clipEnv = {
      DB: env.DB,
      CACHE: env.CACHE,
      SOURCE_ENCRYPTION_KEY: clipKey,
      ANTRA_BASE: base,
      ANTRA_USERNAME: "u",
      ANTRA_PASSWORD: "p",
    } as unknown as Env;
    // A reload and a prepare both see a cold cache while the warm runs:
    // each serves the preview, only the first submits the job.
    await Promise.all([
      roundClip(clipEnv, candidate, "intro", collect),
      roundClip(clipEnv, candidate, "intro", collect),
    ]);
    expect(works).toHaveLength(1);
    await works.pop();
    expect(jobs).toBe(1);
    expect(await env.CACHE.get("antra:ready:42")).not.toBeNull();
    // Now warm, the next serve gets the clip URL without any new lookup.
    const preview = await roundClip(clipEnv, candidate, "intro", collect);
    expect(preview?.url).toContain("/play/clip/42");
    expect(works).toHaveLength(0);
  });

  it("clears the warming marker when the download is unusable", async () => {
    works.length = 0;
    const base = "https://antra.test";
    let jobs = 0;
    network.use(
      deezerTracks(),
      http.post(`${base}/api/auth/login`, () =>
        HttpResponse.json({}, { headers: { "set-cookie": "s=x" } }),
      ),
      http.post(`${base}/api/jobs`, () => {
        jobs += 1;
        return HttpResponse.json({ job_id: "j1" });
      }),
      http.get(`${base}/api/jobs/j1/status`, () =>
        HttpResponse.json({
          status: "done",
          done: 1,
          total: 1,
          filename: "x.mp3",
          error: null,
        }),
      ),
      http.get(
        `${base}/api/jobs/j1/tracks/0/download`,
        () => new HttpResponse(null),
      ),
    );
    const clipEnv = {
      DB: env.DB,
      CACHE: env.CACHE,
      SOURCE_ENCRYPTION_KEY: clipKey,
      ANTRA_BASE: base,
      ANTRA_USERNAME: "u",
      ANTRA_PASSWORD: "p",
    } as unknown as Env;
    await roundClip(clipEnv, candidate, "intro", collect);
    expect(works).toHaveLength(1);
    await works.pop();
    expect(jobs).toBe(1);
    // The empty download counts as a failure: nothing cached, the claim
    // released, and the next cold serve retries with a new job.
    expect(await env.CACHE.get("antra:ready:42")).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT deezer_id FROM warm_claims WHERE deezer_id = 42",
      ).first(),
    ).toBeNull();
    await roundClip(clipEnv, candidate, "intro", collect);
    expect(works).toHaveLength(1);
    await works.pop();
    expect(jobs).toBe(2);
  });

  it("retries on the next serve when the claim write fails", async () => {
    works.length = 0;
    const base = "https://antra.test";
    let jobs = 0;
    network.use(
      deezerTracks(),
      http.post(`${base}/api/auth/login`, () =>
        HttpResponse.json({}, { headers: { "set-cookie": "s=x" } }),
      ),
      http.post(`${base}/api/jobs`, () => {
        jobs += 1;
        return HttpResponse.json({ job_id: "j1" });
      }),
      http.get(`${base}/api/jobs/j1/status`, () =>
        HttpResponse.json({
          status: "done",
          done: 1,
          total: 1,
          filename: "x.mp3",
          error: null,
        }),
      ),
      http.get(`${base}/api/jobs/j1/tracks/0/download`, () =>
        HttpResponse.text("mp3bytes"),
      ),
      http.post(
        `${base}/api/jobs/j1/tracks/0/ack`,
        () => new HttpResponse(null),
      ),
    );
    const brokenDb = {
      prepare: () => {
        throw new Error("D1 down");
      },
    };
    const clipEnv = {
      DB: brokenDb,
      CACHE: env.CACHE,
      SOURCE_ENCRYPTION_KEY: clipKey,
      ANTRA_BASE: base,
      ANTRA_USERNAME: "u",
      ANTRA_PASSWORD: "p",
    } as unknown as Env;
    // A claim that cannot be written still serves the preview and schedules
    // nothing; the next serve with a healthy DB submits the job.
    const preview = await roundClip(clipEnv, candidate, "intro", collect);
    expect(preview?.url).toBe("https://cdn.example/42.mp3");
    expect(works).toHaveLength(0);
    clipEnv.DB = env.DB;
    await roundClip(clipEnv, candidate, "intro", collect);
    expect(works).toHaveLength(1);
    await works.pop();
    expect(jobs).toBe(1);
  });

  it("keeps a reclaimed claim when the stale owner finishes", async () => {
    works.length = 0;
    const base = "https://antra.test";
    const jobs: string[] = [];
    const statuses = new Map<string, string>();
    // A barrier in the status route: both warms' first polls must be in
    // flight before either proceeds, so the job order below is certain.
    let arrivals = 0;
    let bothArrived: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    network.use(
      deezerTracks(),
      http.post(`${base}/api/auth/login`, () =>
        HttpResponse.json({}, { headers: { "set-cookie": "s=x" } }),
      ),
      http.post(`${base}/api/jobs`, () => {
        const id = `j${jobs.length + 1}`;
        jobs.push(id);
        statuses.set(id, "running");
        return HttpResponse.json({ job_id: id });
      }),
      http.get(`${base}/api/jobs/:job/status`, async ({ params }) => {
        arrivals += 1;
        if (arrivals === 2) bothArrived();
        await gate;
        const status = statuses.get(params.job as string) ?? "running";
        return HttpResponse.json({
          status,
          done: status === "done" ? 1 : 0,
          total: 1,
          filename: "x.mp3",
          error: null,
        });
      }),
      http.get(`${base}/api/jobs/:job/tracks/0/download`, () =>
        HttpResponse.text("mp3bytes"),
      ),
      http.post(
        `${base}/api/jobs/:job/tracks/0/ack`,
        () => new HttpResponse(null),
      ),
    );
    const clipEnv = {
      DB: env.DB,
      CACHE: env.CACHE,
      SOURCE_ENCRYPTION_KEY: clipKey,
      ANTRA_BASE: base,
      ANTRA_USERNAME: "u",
      ANTRA_PASSWORD: "p",
    } as unknown as Env;
    await roundClip(clipEnv, candidate, "intro", collect);
    // The first worker's claim goes stale while it still polls; a second
    // serve reclaims the track and starts its own job.
    await env.DB.prepare(
      "UPDATE warm_claims SET claimed_at = claimed_at - 10000 WHERE deezer_id = 42",
    ).run();
    await roundClip(clipEnv, candidate, "intro", collect);
    await gate;
    expect(jobs).toHaveLength(2);
    // The stale worker finishing must not delete the newer claim.
    statuses.set(jobs[0], "done");
    await works.shift();
    expect(
      await env.DB.prepare(
        "SELECT deezer_id FROM warm_claims WHERE deezer_id = 42",
      ).first(),
    ).not.toBeNull();
    // A third concurrent serve finds the live claim and submits nothing.
    await roundClip(clipEnv, candidate, "intro", collect);
    expect(jobs).toHaveLength(2);
    statuses.set(jobs[1], "done");
    await works.shift();
    expect(jobs).toHaveLength(2);
    expect(await env.CACHE.get("antra:ready:42")).not.toBeNull();
  });

  it("serves clip bytes only with a signed URL", async () => {
    await env.CACHE.put("antra:track:42", "mp3bytes");
    const url = await clipUrl(
      { SOURCE_ENCRYPTION_KEY: clipKey } as unknown as Env,
      42,
    );
    expect(url).not.toBeNull();
    const [path, fragment] = url!.split("#");
    const ok = await app.fetch(new Request(`${origin}${path}`), testEnv());
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/mpeg");
    expect(await ok.arrayBuffer()).toEqual(
      new TextEncoder().encode("mp3bytes").buffer,
    );
    expect(fragment).toBe("t=0,10");
    const unsigned = await app.fetch(
      new Request(`${origin}/play/clip/42`),
      testEnv(),
    );
    expect(unsigned.status).toBe(404);
  });
});
