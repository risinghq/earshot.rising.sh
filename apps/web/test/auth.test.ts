import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { network } from "./network";

const now = Math.floor(Date.now() / 1000);
const origin = "https://earshot.rising.sh";

const testEnv = () => ({
  DB: env.DB,
  CACHE: env.CACHE,
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
});

function cookieValue(response: Response, name: string) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  return match?.[1];
}

// GitHub answers the code exchange and the user lookup; `asked` lists the
// URLs the Worker requested.
function githubAnswers(user: { id: number; login: string }) {
  const asked: string[] = [];
  network.use(
    http.post("https://github.com/login/oauth/access_token", ({ request }) => {
      asked.push(request.url);
      return HttpResponse.json({ access_token: "gh-token" });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      asked.push(request.url);
      return HttpResponse.json(user);
    }),
  );
  return asked;
}

async function begin() {
  const response = await app.fetch(
    new Request(`${origin}/auth/github`),
    testEnv() as never,
  );
  const state = new URL(
    response.headers.get("location") ?? "",
  ).searchParams.get("state");
  return { response, state };
}

async function signIn(user: { id: number; login: string }) {
  const { state } = await begin();
  const asked = githubAnswers(user);
  const response = await app.fetch(
    new Request(`${origin}/auth/github/callback?code=code-1&state=${state}`, {
      headers: { cookie: `__Host-oauth-state=${state}` },
    }),
    testEnv() as never,
  );
  return {
    response,
    asked,
    session: cookieValue(response, "__Host-session"),
  };
}

describe("home page", () => {
  it("leads with the games and invites a signed-out visitor to sign in", async () => {
    const response = await app.fetch(
      new Request(`${origin}/`),
      testEnv() as never,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const href of ["/", "/play/board", "/groups", "/auth/github"])
      expect(body).toContain(`href="${href}"`);
    expect(body).toContain('class="genres"');
  });

  it("serves the home page to a signed-in visitor with profile links", async () => {
    const { session } = await signIn({ id: 7, login: "octo" });
    const response = await app.fetch(
      new Request(`${origin}/`, {
        headers: { cookie: `__Host-session=${session}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('href="/u/octo"');
    expect(body).toContain('href="/settings"');
    expect(body).toContain('href="/"');
    expect(body).toContain('href="/groups"');
    expect(body).toContain('href="/friends"');
  });
});

describe("/auth/github", () => {
  it("redirects to GitHub with a state cookie and no scope", async () => {
    const { response } = await begin();
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(target.searchParams.get("client_id")).toBe("test-client-id");
    expect(target.searchParams.get("redirect_uri")).toBe(
      `${origin}/auth/github/callback`,
    );
    expect(target.searchParams.get("state")).toHaveLength(22);
    expect(target.searchParams.has("scope")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("__Host-oauth-state=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("answers 503 when the client id and secret are missing", async () => {
    const response = await app.fetch(new Request(`${origin}/auth/github`), {
      DB: env.DB,
      CACHE: env.CACHE,
    } as never);
    expect(response.status).toBe(503);
  });
});

describe("/auth/github/callback", () => {
  it.each<[string, { cookie?: string }]>([
    ["a missing state cookie", {}],
    ["a mismatched state", { cookie: "other" }],
  ])("rejects %s", async (_name, setup) => {
    const { state } = await begin();
    const response = await app.fetch(
      new Request(`${origin}/auth/github/callback?code=c&state=${state}`, {
        headers:
          setup.cookie === undefined
            ? {}
            : { cookie: `__Host-oauth-state=${setup.cookie}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(400);
  });

  it("creates the user, stores github_id and discards the token", async () => {
    const { response, asked, session } = await signIn({
      id: 12345,
      login: "OctoCat",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings");
    expect(asked).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    expect(session).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("__Host-session=");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");

    const user = await env.DB.prepare(
      "SELECT github_id, name, is_public FROM users",
    ).first<{ github_id: number; name: string; is_public: number }>();
    expect(user).toEqual({ github_id: 12345, name: "octocat", is_public: 1 });
    const sessions = await env.DB.prepare(
      "SELECT user_id, expires_at FROM sessions",
    ).all<{ user_id: number; expires_at: number }>();
    expect(sessions.results).toHaveLength(1);
    expect(sessions.results[0]?.expires_at).toBeGreaterThanOrEqual(
      now + 29 * 86400,
    );
    const columnCheck = await env.DB.prepare(
      "SELECT * FROM users WHERE github_id = 12345",
    ).first();
    expect(JSON.stringify(columnCheck)).not.toContain("gh-token");
  });

  it("keeps a renamed profile name on the next sign-in", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (9, 'renamed', ?1)",
    )
      .bind(now)
      .run();
    await signIn({ id: 9, login: "Whatever" });
    const user = await env.DB.prepare(
      "SELECT name FROM users WHERE github_id = 9",
    ).first<{ name: string }>();
    expect(user?.name).toBe("renamed");
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });

  it("picks a free name when the GitHub login is taken", async () => {
    await env.DB.prepare(
      "INSERT INTO users (github_id, name, created_at) VALUES (1, 'octo', ?1)",
    )
      .bind(now)
      .run();
    await signIn({ id: 42, login: "Octo" });
    const user = await env.DB.prepare(
      "SELECT name FROM users WHERE github_id = 42",
    ).first<{ name: string }>();
    expect(user?.name).toBe("octo-2");
  });

  it("answers 502 when the code exchange fails", async () => {
    const { state } = await begin();
    network.use(
      http.post(
        "https://github.com/login/oauth/access_token",
        () => new HttpResponse("denied", { status: 403 }),
      ),
    );
    const response = await app.fetch(
      new Request(`${origin}/auth/github/callback?code=bad&state=${state}`, {
        headers: { cookie: `__Host-oauth-state=${state}` },
      }),
      testEnv() as never,
    );
    expect(response.status).toBe(502);
  });
});

const encode = (value: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

// Google's token endpoint answers only the app's own secret and callback.
function googleAnswers(claims: Record<string, unknown>) {
  const token = `${encode({ alg: "RS256" })}.${encode({
    iss: "https://accounts.google.com",
    aud: "google-client-id",
    ...claims,
  })}.signature`;
  network.use(
    http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (
        body.get("client_secret") !== "google-client-secret" ||
        body.get("redirect_uri") !== `${origin}/auth/google/callback`
      )
        return new HttpResponse("bad client", { status: 401 });
      return HttpResponse.json({ id_token: token });
    }),
  );
}

async function googleSignIn(claims: Record<string, unknown>, cookie = "") {
  const begin = await app.fetch(
    new Request(`${origin}/auth/google`),
    testEnv() as never,
  );
  const state = new URL(begin.headers.get("location") ?? "").searchParams.get(
    "state",
  );
  googleAnswers(claims);
  return app.fetch(
    new Request(`${origin}/auth/google/callback?code=c&state=${state}`, {
      headers: { cookie: `__Host-oauth-state=${state}${cookie}` },
    }),
    testEnv() as never,
  );
}

describe("Google sign-in", () => {
  it("asks Google for the openid, email and profile scopes", async () => {
    const response = await app.fetch(
      new Request(`${origin}/auth/google?next=/groups`),
      testEnv() as never,
    );
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.origin).toBe("https://accounts.google.com");
    expect(target.searchParams.get("scope")).toBe("openid email profile");
    expect(target.searchParams.get("client_id")).toBe("google-client-id");
    expect(response.headers.get("set-cookie")).toContain("__Host-oauth-next=");
  });

  it("creates a user named after the given name, with no GitHub id", async () => {
    const response = await googleSignIn({
      sub: "g-1",
      email: "ana@example.com",
      given_name: "Ána",
    });
    expect(response.status).toBe(303);
    expect(cookieValue(response, "__Host-session")).toBeTruthy();
    const user = await env.DB.prepare(
      "SELECT github_id, google_sub, google_email, name FROM users",
    ).first<Record<string, unknown>>();
    expect(user).toMatchObject({
      google_sub: "g-1",
      google_email: "ana@example.com",
      name: "ana",
    });
    expect(user?.github_id).toBeLessThan(0);

    await googleSignIn({ sub: "g-1", email: "new@example.com" });
    const again = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(google_email) AS email FROM users",
    ).first();
    expect(again).toEqual({ n: 1, email: "new@example.com" });
  });

  it("refuses a token meant for another client", async () => {
    const response = await googleSignIn({
      sub: "g-1",
      email: "a@example.com",
      aud: "someone-else",
    });
    expect(response.status).toBe(502);
  });

  it("links Google to the signed-in GitHub account, once", async () => {
    const { session } = await signIn({ id: 7, login: "octo" });
    const linked = await googleSignIn(
      { sub: "g-7", email: "octo@example.com" },
      `; __Host-session=${session}`,
    );
    expect(linked.status).toBe(303);
    expect(linked.headers.get("location")).toBe("/settings#account");
    const user = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(github_id) AS github_id, MAX(google_sub) AS sub FROM users",
    ).first();
    expect(user).toEqual({ n: 1, github_id: 7, sub: "g-7" });

    const second = await googleSignIn(
      { sub: "g-8", email: "other@example.com" },
      `; __Host-session=${session}`,
    );
    expect(second.status).toBe(409);
  });

  it("refuses to link an account that signs in to another profile", async () => {
    await googleSignIn({ sub: "g-9", email: "first@example.com" });
    const { session } = await signIn({ id: 8, login: "second" });
    const response = await googleSignIn(
      { sub: "g-9", email: "first@example.com" },
      `; __Host-session=${session}`,
    );
    expect(response.status).toBe(409);
  });
});
