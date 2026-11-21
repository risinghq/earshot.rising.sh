import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { mergeAnonOutcomes } from "./play/outcomes";
import type { Context } from "hono";
import type { Env } from "./types";

const sessionSeconds = 30 * 86400;
const stateSeconds = 600;

const cookieBase = {
  prefix: "host",
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

export const cookieClear = {
  prefix: "host",
  secure: true,
  path: "/",
} as const;

export interface SignedInUser {
  id: number;
  github_id: number;
  name: string;
  is_public: number;
}

export type Provider = "github" | "google";

export const providerNames: Record<Provider, string> = {
  github: "GitHub",
  google: "Google",
};

// One account at a provider, as its callback proves it. `name` seeds the
// profile name of a new user.
type Identity =
  | { provider: "github"; id: number; login: string; name: string }
  | { provider: "google"; sub: string; email: string; name: string };

const reservedNames = new Set(["api", "auth", "settings", "u"]);
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export function validName(name: string) {
  return namePattern.test(name) && !reservedNames.has(name);
}

// An account made through Google holds a negative github_id until GitHub is
// linked (migrations/0020_google_login.sql).
export function hasGithub(user: { github_id: number }) {
  return user.github_id > 0;
}

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function sha256Bytes(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

type AuthContext = Context<{ Bindings: Env }>;

export async function sessionUser<E extends { Bindings: Env }>(
  context: Context<E>,
) {
  const value = getCookie(context, "session", "host");
  if (value === undefined) return null;
  const env = context.env;
  const now = Math.floor(Date.now() / 1000);
  const hash = await sha256Bytes(value);
  return env.DB.prepare(
    `SELECT users.id, users.github_id, users.name, users.is_public
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.hash = ?1 AND sessions.expires_at > ?2`,
  )
    .bind(hash, now)
    .first<SignedInUser>();
}

export async function newSession(db: D1Database, userId: number, now: number) {
  const value = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Bytes(value);
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    db
      .prepare(
        "INSERT INTO sessions (hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
      )
      .bind(hash, userId, now + sessionSeconds),
  ]);
  return value;
}

export async function endSession<E extends { Bindings: Env }>(
  context: Context<E>,
) {
  const value = getCookie(context, "session", "host");
  if (value === undefined) return;
  const hash = await sha256Bytes(value);
  await context.env.DB.prepare("DELETE FROM sessions WHERE hash = ?1")
    .bind(hash)
    .run();
}

function credentials(context: AuthContext, provider: Provider) {
  const id =
    provider === "github"
      ? context.env.GITHUB_CLIENT_ID
      : context.env.GOOGLE_CLIENT_ID;
  const secret =
    provider === "github"
      ? context.env.GITHUB_CLIENT_SECRET
      : context.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret)
    return context.text(
      `${providerNames[provider]} sign-in is not configured`,
      503,
    );
  return { id, secret };
}

// Only a path on this origin is a return target, so the sign-in link cannot
// send someone to another site after the provider approves them.
export function returnPath(value: string | undefined) {
  return value !== undefined && /^\/(?![/\\])/.test(value) ? value : null;
}

// The page that offers each provider and comes back to `next` after.
export function signInHref(next: string) {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

export function providerHref(provider: Provider, next: string) {
  return `/auth/${provider}?next=${encodeURIComponent(next)}`;
}

const callbackUrl = (context: AuthContext, provider: Provider) =>
  `${new URL(context.req.url).origin}/auth/${provider}/callback`;

export function beginSignIn(context: AuthContext, provider: Provider) {
  const client = credentials(context, provider);
  if (client instanceof Response) return client;
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const target =
    provider === "github"
      ? new URL("https://github.com/login/oauth/authorize")
      : new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", client.id);
  target.searchParams.set("redirect_uri", callbackUrl(context, provider));
  target.searchParams.set("state", state);
  if (provider === "google") {
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", "openid email profile");
    target.searchParams.set("prompt", "select_account");
  }
  setCookie(context, "oauth-state", state, {
    ...cookieBase,
    maxAge: stateSeconds,
  });
  const next = returnPath(context.req.query("next"));
  if (next !== null)
    setCookie(context, "oauth-next", next, {
      ...cookieBase,
      maxAge: stateSeconds,
    });
  return context.redirect(target.toString(), 302);
}

async function availableName(db: D1Database, seed: string) {
  const base =
    seed
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 39) || "user";
  for (let n = 0; n < 100; n += 1) {
    const suffix = n === 0 ? "" : `-${n + 1}`;
    const name = `${base.slice(0, 39 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!validName(name)) continue;
    const taken = await db
      .prepare("SELECT 1 AS taken FROM users WHERE name = ?1 COLLATE NOCASE")
      .bind(name)
      .first();
    if (taken === null) return name;
  }
  return `user-${base64url(crypto.getRandomValues(new Uint8Array(6)))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "0")}`;
}

interface UserRow {
  id: number;
  name: string;
}

function findByIdentity(db: D1Database, identity: Identity) {
  return identity.provider === "github"
    ? db
        .prepare("SELECT id, name FROM users WHERE github_id = ?1")
        .bind(identity.id)
        .first<UserRow>()
    : db
        .prepare("SELECT id, name FROM users WHERE google_sub = ?1")
        .bind(identity.sub)
        .first<UserRow>();
}

// Keeps the login or address the provider shows now, for the settings page.
function refreshIdentity(db: D1Database, userId: number, identity: Identity) {
  return identity.provider === "github"
    ? db
        .prepare("UPDATE users SET github_login = ?1 WHERE id = ?2")
        .bind(identity.login, userId)
    : db
        .prepare("UPDATE users SET google_email = ?1 WHERE id = ?2")
        .bind(identity.email, userId);
}

// Links the identity to a signed-in user who has none from that provider yet.
// Returns false when the user already has one.
async function linkIdentity(
  db: D1Database,
  userId: number,
  identity: Identity,
) {
  const result = await (
    identity.provider === "github"
      ? db
          .prepare(
            `UPDATE users SET github_id = ?1, github_login = ?2
           WHERE id = ?3 AND github_id < 0`,
          )
          .bind(identity.id, identity.login, userId)
      : db
          .prepare(
            `UPDATE users SET google_sub = ?1, google_email = ?2
           WHERE id = ?3 AND google_sub IS NULL`,
          )
          .bind(identity.sub, identity.email, userId)
  ).run();
  return result.meta.changes === 1;
}

async function createUser(db: D1Database, identity: Identity, now: number) {
  const name = await availableName(db, identity.name);
  const statement =
    identity.provider === "github"
      ? db
          .prepare(
            `INSERT INTO users (github_id, github_login, name, created_at)
             VALUES (?1, ?2, ?3, ?4) RETURNING id, name`,
          )
          .bind(identity.id, identity.login, name, now)
      : db
          .prepare(
            `INSERT INTO users
             (github_id, google_sub, google_email, name, created_at)
             VALUES (-1 - abs(random() % 1000000000000), ?1, ?2, ?3, ?4)
             RETURNING id, name`,
          )
          .bind(identity.sub, identity.email, name, now);
  try {
    const created = await statement.first<UserRow>();
    if (created !== null) return created;
  } catch {
    // Two sign-ins raced on the same account.
  }
  const raced = await findByIdentity(db, identity);
  if (raced === null) throw new Error("could not create the user");
  return raced;
}

type Outcome =
  | { kind: "signed-in"; user: UserRow }
  | { kind: "linked" }
  | { kind: "taken" }
  | { kind: "has-one" };

// A visitor already signed in links the identity to their own account; anyone
// else signs in to the account that holds it, or a new one.
async function resolveIdentity(
  db: D1Database,
  identity: Identity,
  current: SignedInUser | null,
  now: number,
): Promise<Outcome> {
  const existing = await findByIdentity(db, identity);
  if (current !== null) {
    if (existing !== null)
      return existing.id === current.id
        ? { kind: "linked" }
        : { kind: "taken" };
    return (await linkIdentity(db, current.id, identity))
      ? { kind: "linked" }
      : { kind: "has-one" };
  }
  if (existing !== null) {
    await refreshIdentity(db, existing.id, identity).run();
    return { kind: "signed-in", user: existing };
  }
  return { kind: "signed-in", user: await createUser(db, identity, now) };
}

async function githubIdentity(
  context: AuthContext,
  client: { id: string; secret: string },
  code: string,
): Promise<Identity | null> {
  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      code,
      redirect_uri: callbackUrl(context, "github"),
    }).toString(),
  });
  if (!exchange.ok) return null;
  const token = (await exchange.json()) as { access_token?: string };
  if (typeof token.access_token !== "string") return null;
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "music-stats-web",
    },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: unknown; login?: unknown };
  if (typeof user.id !== "number" || typeof user.login !== "string")
    return null;
  return {
    provider: "github",
    id: user.id,
    login: user.login,
    name: user.login,
  };
}

function jwtPayload(token: string) {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const text = atob(part.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

// The ID token comes straight from Google's token endpoint over TLS in
// exchange for the client secret, so its signature needs no check; its
// audience and issuer still must be this client and Google.
async function googleIdentity(
  context: AuthContext,
  client: { id: string; secret: string },
  code: string,
): Promise<Identity | null> {
  const exchange = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(context, "google"),
    }).toString(),
  });
  if (!exchange.ok) return null;
  const token = (await exchange.json()) as { id_token?: unknown };
  if (typeof token.id_token !== "string") return null;
  const claims = jwtPayload(token.id_token);
  if (
    claims === null ||
    claims.aud !== client.id ||
    (claims.iss !== "https://accounts.google.com" &&
      claims.iss !== "accounts.google.com") ||
    typeof claims.sub !== "string" ||
    typeof claims.email !== "string"
  )
    return null;
  const name =
    typeof claims.given_name === "string"
      ? claims.given_name
      : typeof claims.name === "string"
        ? claims.name
        : "user";
  return { provider: "google", sub: claims.sub, email: claims.email, name };
}

const linkMessages = {
  taken: (provider: string) =>
    `That ${provider} account already signs in to another Earshot profile.`,
  "has-one": (provider: string) =>
    `Your profile already has a ${provider} account.`,
};

export async function signInCallback(context: AuthContext, provider: Provider) {
  const client = credentials(context, provider);
  if (client instanceof Response) return client;
  const code = context.req.query("code");
  const state = context.req.query("state");
  const expected = getCookie(context, "oauth-state", "host");
  deleteCookie(context, "oauth-state", cookieClear);
  const next = returnPath(getCookie(context, "oauth-next", "host"));
  deleteCookie(context, "oauth-next", cookieClear);
  if (!code || !state || expected === undefined || state !== expected)
    return context.text("The sign-in state does not match. Start again.", 400);

  const identity = await (provider === "github"
    ? githubIdentity(context, client, code)
    : googleIdentity(context, client, code));
  if (identity === null)
    return context.text(
      `${providerNames[provider]} sign-in failed. Start again.`,
      502,
    );

  const now = Math.floor(Date.now() / 1000);
  const db = context.env.DB;
  const outcome = await resolveIdentity(
    db,
    identity,
    await sessionUser(context),
    now,
  );
  if (outcome.kind === "taken" || outcome.kind === "has-one")
    return context.text(
      linkMessages[outcome.kind](providerNames[provider]),
      409,
    );
  if (outcome.kind === "linked")
    return context.redirect(next ?? "/settings#account", 303);

  const anon = getCookie(context, "play-id", "host");
  if (anon !== undefined) await mergeAnonOutcomes(db, anon, outcome.user.id);
  const session = await newSession(db, outcome.user.id, now);
  setCookie(context, "session", session, {
    ...cookieBase,
    maxAge: sessionSeconds,
  });
  return context.redirect(next ?? "/settings", 303);
}
