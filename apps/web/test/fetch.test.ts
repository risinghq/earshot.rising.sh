import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { network } from "./network";

const origin = "https://earshot.rising.sh";
const antra = "https://antra.test";

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  ANTRA_BASE: antra,
  ANTRA_USERNAME: "u",
  ANTRA_PASSWORD: "p",
});

function cookieValue(response: Response, name: string) {
  const header = response.headers.get("set-cookie") ?? "";
  return new RegExp(`${name}=([^;]*)`).exec(header)?.[1];
}

async function signIn(user = { id: 7, login: "octo" }) {
  const begin = await app.fetch(
    new Request(`${origin}/auth/github`),
    testEnv() as never,
  );
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get(
    "state",
  );
  network.use(
    http.post("https://github.com/login/oauth/access_token", () =>
      HttpResponse.json({ access_token: "gh" }),
    ),
    http.get("https://api.github.com/user", () => HttpResponse.json(user)),
  );
  const response = await app.fetch(
    new Request(`${origin}/auth/github/callback?code=c&state=${state}`, {
      headers: { cookie: `__Host-oauth-state=${state}` },
    }),
    testEnv() as never,
  );
  return cookieValue(response, "__Host-session")!;
}

const trackUrl = "https://www.deezer.com/track/1";

function antraAnswers(options: { failLogin?: boolean } = {}) {
  const calls: string[] = [];
  network.use(
    http.post(`${antra}/api/auth/login`, () => {
      calls.push("login");
      if (options.failLogin) return new HttpResponse(null, { status: 401 });
      return HttpResponse.json(
        { ok: true },
        { headers: { "set-cookie": "antra_session=abc; Path=/" } },
      );
    }),
    http.post(`${antra}/api/resolve`, ({ request }) => {
      calls.push("resolve");
      if (request.headers.get("cookie")?.includes("stale"))
        return HttpResponse.json({ detail: "expired" }, { status: 401 });
      return HttpResponse.json({
        release_type: "track",
        tracks: [{ title: "Song", artist: "Artist" }],
      });
    }),
    http.post(`${antra}/api/jobs`, () => {
      calls.push("jobs");
      return HttpResponse.json({ job_id: "job-1" }, { status: 201 });
    }),
    http.get(`${antra}/api/jobs/job-1/status`, () => {
      calls.push("status");
      return HttpResponse.json({
        status: "complete",
        done: 1,
        total: 1,
        filename: "Song.mp3",
        error: null,
      });
    }),
    http.get(`${antra}/api/jobs/job-1/tracks/0/download`, () => {
      calls.push("download");
      return new HttpResponse(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "audio/mpeg",
          "content-disposition": 'attachment; filename="Song.mp3"',
        },
      });
    }),
    http.post(`${antra}/api/jobs/job-1/tracks/0/ack`, () => {
      calls.push("ack");
      return HttpResponse.json({ ok: true });
    }),
  );
  return calls;
}

const authed = (session: string, init?: RequestInit) =>
  new Request(`${origin}/fetch`, {
    ...init,
    headers: { cookie: `__Host-session=${session}`, ...init?.headers },
  });

describe("fetch api", () => {
  it("rejects anonymous requests", async () => {
    const response = await app.fetch(
      new Request(`${origin}/fetch`, { method: "POST" }),
      testEnv() as never,
    );
    expect(response.status).toBe(401);
  });

  it("runs resolve → job → status → download", async () => {
    const calls = antraAnswers();
    const session = await signIn();

    const created = await app.fetch(
      authed(session, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trackUrl }),
      }),
      testEnv() as never,
    );
    expect(created.status).toBe(201);
    const { id, trackCount } = (await created.json()) as {
      id: string;
      trackCount: number;
    };
    expect(trackCount).toBe(1);

    const status = await app.fetch(
      new Request(`${origin}/fetch/${id}`, {
        headers: { cookie: `__Host-session=${session}` },
      }),
      testEnv() as never,
    );
    expect(((await status.json()) as { status: string }).status).toBe(
      "complete",
    );

    const file = await app.fetch(
      new Request(`${origin}/fetch/${id}/tracks/0`, {
        headers: { cookie: `__Host-session=${session}` },
      }),
      testEnv() as never,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(calls).toContain("download");
  });

  it("re-logs in once when antra answers 401", async () => {
    const calls = antraAnswers();
    const session = await signIn();
    await env.CACHE.put("antra:cookie", "stale=1");

    const created = await app.fetch(
      authed(session, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trackUrl }),
      }),
      testEnv() as never,
    );
    expect(created.status).toBe(201);
    expect(calls.filter((c) => c === "login")).toHaveLength(1);
  });

  it("scopes a fetch to its owner", async () => {
    antraAnswers();
    const session = await signIn();
    const created = await app.fetch(
      authed(session, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trackUrl }),
      }),
      testEnv() as never,
    );
    const { id } = (await created.json()) as { id: string };

    const other = await signIn({ id: 8, login: "second" });
    const status = await app.fetch(
      new Request(`${origin}/fetch/${id}`, {
        headers: { cookie: `__Host-session=${other}` },
      }),
      testEnv() as never,
    );
    expect(status.status).toBe(404);
  });
});
