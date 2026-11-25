import { Hono } from "hono";
import * as v from "valibot";
import { sessionUser, type SignedInUser } from "../account/auth";
import type { Env } from "../env";
import * as antra from "./antra";

export const fetchApp = new Hono<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}>();

const postSchema = v.object({ url: v.pipe(v.string(), v.url()) });
const fetchTtl = 3600;

type FetchRecord = {
  jobId: string;
  userId: number;
  url: string;
  trackCount: number;
  retried: boolean;
};

const recordKey = (id: string) => `fetch:${id}`;

async function record(env: Env, id: string): Promise<FetchRecord | null> {
  return env.CACHE.get<FetchRecord>(recordKey(id), "json");
}

function upstreamError(error: unknown) {
  const e = error as { status?: number; message?: string };
  return { error: e.message ?? "upstream failed", status: e.status ?? 502 };
}

// Every route needs a signed-in user; fetches are scoped to their owner.
fetchApp.use("*", async (context, next) => {
  const user = await sessionUser(context);
  if (user === null) return context.json({ error: "sign in" }, 401);
  context.set("user", user);
  await next();
});

fetchApp.post("/", async (context) => {
  const body = v.safeParse(
    postSchema,
    await context.req.json().catch(() => ({})),
  );
  if (!body.success) return context.json({ error: "url" }, 400);
  const url = body.output.url;

  let resolved;
  try {
    resolved = await antra.resolve(context.env, url);
  } catch (error) {
    const e = upstreamError(error);
    return context.json({ error: e.error }, e.status as 400);
  }
  const trackCount = resolved.tracks.length;
  if (trackCount === 0) return context.json({ error: "nothing to fetch" }, 422);

  let jobId: string;
  try {
    jobId = await antra.submitJob(context.env, url);
  } catch (error) {
    const e = upstreamError(error);
    return context.json({ error: e.error }, e.status as 400);
  }

  const id = crypto.randomUUID();
  const user = context.get("user");
  const rec: FetchRecord = {
    jobId,
    userId: user.id,
    url,
    trackCount,
    retried: false,
  };
  await context.env.CACHE.put(recordKey(id), JSON.stringify(rec), {
    expirationTtl: fetchTtl,
  });
  return context.json(
    { id, trackCount, releaseType: resolved.release_type },
    201,
  );
});

fetchApp.get("/:id", async (context) => {
  const rec = await record(context.env, context.req.param("id"));
  const user = context.get("user");
  if (!rec || rec.userId !== user.id)
    return context.json({ error: "not found" }, 404);

  try {
    const status = await antra.jobStatus(context.env, rec.jobId);
    // Antra's Deezer pool exhausts transiently; one silent resubmit rides out
    // the quota gap that otherwise surfaces as a failed job.
    if (
      status.status === "failed" &&
      !rec.retried &&
      status.error?.includes("Quota limit exceeded")
    ) {
      rec.retried = true;
      rec.jobId = await antra.submitJob(context.env, rec.url);
      await context.env.CACHE.put(
        recordKey(context.req.param("id")),
        JSON.stringify(rec),
        {
          expirationTtl: fetchTtl,
        },
      );
      return context.json({
        status: "pending",
        done: 0,
        total: rec.trackCount,
      });
    }
    return context.json(status);
  } catch (error) {
    const e = upstreamError(error);
    return context.json({ error: e.error }, e.status as 400);
  }
});

fetchApp.get("/:id/tracks/:index", async (context) => {
  const rec = await record(context.env, context.req.param("id"));
  const user = context.get("user");
  if (!rec || rec.userId !== user.id)
    return context.json({ error: "not found" }, 404);
  const index = Number(context.req.param("index"));
  if (!Number.isInteger(index) || index < 0 || index >= rec.trackCount)
    return context.json({ error: "index" }, 400);

  let upstream: Response;
  try {
    upstream = await antra.trackDownload(context.env, rec.jobId, index);
  } catch (error) {
    const e = upstreamError(error);
    return context.json({ error: e.error }, e.status as 400);
  }

  // The file streams through; the isolate never buffers it. Ack after the
  // body is sent so antra can drop its copy — waitUntil keeps the ack off the
  // response path.
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const [responseStream, ackStream] = upstream.body!.tee();
  let waitUntil: ((work: Promise<unknown>) => void) | undefined;
  try {
    const ctx = context.executionCtx;
    waitUntil = ctx.waitUntil.bind(ctx);
  } catch {
    waitUntil = undefined;
  }
  if (waitUntil)
    waitUntil(
      ackStream
        .pipeTo(new WritableStream())
        .then(() => antra.ackTrack(context.env, rec.jobId, index))
        .catch(() => {}),
    );
  return new Response(responseStream, { status: 200, headers });
});
