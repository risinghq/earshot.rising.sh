import * as v from "valibot";
import type { Env } from "../env";

// antra.hoshi.cfd rips a pasted link into files through a server-side job.
// The account's session cookie is reused across requests from KV so each
// fetch does not pay a login round-trip; a 401 logs in once more and retries.
const cookieKey = "antra:cookie";
const cookieTtl = 50 * 60;

// One login per isolate: concurrent 401s share the same refresh instead of
// racing logins on the account.
let loginInFlight: Promise<string> | null = null;

const jobSchema = v.object({ job_id: v.string() });
const statusSchema = v.object({
  status: v.string(),
  done: v.fallback(v.number(), 0),
  total: v.fallback(v.number(), 0),
  filename: v.fallback(v.nullable(v.string()), null),
  error: v.fallback(v.nullable(v.string()), null),
});
const resolveSchema = v.object({
  release_type: v.string(),
  tracks: v.fallback(
    v.array(
      v.object({
        title: v.fallback(v.string(), ""),
        artist: v.fallback(v.string(), ""),
      }),
    ),
    [],
  ),
});
export type ResolveResult = v.InferOutput<typeof resolveSchema>;
export type JobStatus = v.InferOutput<typeof statusSchema>;

class AntraError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function base(env: Env): string {
  return env.ANTRA_BASE ?? "https://antra.hoshi.cfd";
}

async function login(env: Env): Promise<string> {
  const username = env.ANTRA_USERNAME;
  const password = env.ANTRA_PASSWORD;
  if (!username || !password)
    throw new AntraError("antra is not configured", 503);
  const response = await fetch(`${base(env)}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new AntraError("antra login failed", 502);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new AntraError("antra login set no cookie", 502);
  await env.CACHE.put(cookieKey, cookie, { expirationTtl: cookieTtl });
  return cookie;
}

async function cookie(env: Env): Promise<string> {
  const cached = await env.CACHE.get(cookieKey);
  if (cached) return cached;
  loginInFlight ??= login(env).finally(() => {
    loginInFlight = null;
  });
  return loginInFlight;
}

async function call(
  env: Env,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const jar = init.cookie ?? (await cookie(env));
  const response = await fetch(`${base(env)}${path}`, {
    ...init,
    headers: { cookie: jar, ...init.headers },
  });
  if (response.status !== 401 || init.cookie) return response;
  loginInFlight ??= login(env).finally(() => {
    loginInFlight = null;
  });
  const fresh = await loginInFlight;
  return call(env, path, { ...init, cookie: fresh });
}

async function callJson<T>(
  env: Env,
  path: string,
  schema: v.GenericSchema<unknown, T>,
  init?: RequestInit,
): Promise<T> {
  const response = await call(env, path, init);
  if (response.status === 429) throw new AntraError("daily limit reached", 429);
  if (!response.ok) {
    let detail = `antra answered ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {}
    throw new AntraError(detail, response.status === 404 ? 404 : 502);
  }
  const parsed = v.safeParse(schema, await response.json());
  if (!parsed.success) throw new AntraError("unexpected antra body", 502);
  return parsed.output;
}

export async function resolve(env: Env, url: string): Promise<ResolveResult> {
  return callJson(env, "/api/resolve", resolveSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}

export async function submitJob(env: Env, url: string): Promise<string> {
  const job = await callJson(env, "/api/jobs", jobSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, format: "mp3" }),
  });
  return job.job_id;
}

export async function jobStatus(env: Env, jobId: string): Promise<JobStatus> {
  return callJson(env, `/api/jobs/${jobId}/status`, statusSchema);
}

// The body streams through untouched; the caller owns the response and closes
// it. Do not read it here — that would buffer the whole file in the isolate.
export async function trackDownload(
  env: Env,
  jobId: string,
  index: number,
): Promise<Response> {
  const response = await call(
    env,
    `/api/jobs/${jobId}/tracks/${index}/download`,
  );
  if (!response.ok)
    throw new AntraError(
      "track download failed",
      response.status === 404 ? 404 : 502,
    );
  return response;
}

// Frees antra's copy after a successful pull. Fire-and-forget via waitUntil.
export async function ackTrack(env: Env, jobId: string, index: number) {
  await call(env, `/api/jobs/${jobId}/tracks/${index}/ack`, { method: "POST" });
}
