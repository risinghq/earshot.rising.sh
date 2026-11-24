import type { Context } from "hono";
import * as v from "valibot";
import { and, eq, isNull, sql } from "drizzle-orm";
import { database, t } from "../platform/db";
import { markDuplicates } from "./duplicates";
import { storeListens } from "./matching";
import type { Env } from "../env";

const maxListens = 1000;
const minListenedAt = 1104537600;
const leadSeconds = 86400;

const tokenPattern = /^msu_[A-Za-z0-9_-]{43}$/;

// Pano Scrobbler joins the configured server to "1/" plus the route, and sends
// the token as "Authorization: token <key>" (api/listenbrainz/ListenBrainz.kt,
// commonReq). Other clients send "Token" or "Bearer".
const authorizationPattern = /^(?:token|bearer)\s+(\S+)\s*$/i;

const textField = v.pipe(
  v.string(),
  v.check((value) => {
    const length = [...value].length;
    return length >= 1 && length <= 512;
  }),
);

// Clients send junk in the optional metadata fields; a value that fails its
// pattern falls back to absent instead of refusing the whole submission.
const mbidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i;

const identifierField = (pattern: RegExp) =>
  v.fallback(v.optional(v.pipe(v.string(), v.regex(pattern))), undefined);

const metadataSchema = v.object({
  artist_name: textField,
  track_name: textField,
  release_name: v.fallback(v.optional(textField), undefined),
  additional_info: v.fallback(
    v.optional(
      v.object({
        recording_mbid: identifierField(mbidPattern),
        isrc: identifierField(isrcPattern),
      }),
    ),
    undefined,
  ),
});

const bodySchema = v.object({
  listen_type: v.picklist(["single", "import", "playing_now"]),
  payload: v.array(
    v.object({
      listened_at: v.optional(v.pipe(v.number(), v.integer())),
      track_metadata: metadataSchema,
    }),
  ),
});

function fail(context: Context, status: 400 | 401 | 404, error: string) {
  return context.json({ code: status, error }, status);
}

function readToken(header: string | undefined) {
  if (header === undefined) return null;
  const match = authorizationPattern.exec(header);
  if (match === null || !tokenPattern.test(match[1])) return null;
  return match[1];
}

async function authenticate(context: Context<{ Bindings: Env }>) {
  const token = readToken(context.req.header("authorization"));
  if (token === null) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const source = await database(context.env.DB)
    .select({
      tokenId: t.tokens.id,
      sourceId: t.sources.id,
      userId: t.sources.userId,
      userName: t.users.name,
    })
    .from(t.tokens)
    .innerJoin(t.sources, eq(t.sources.id, t.tokens.sourceId))
    .innerJoin(t.users, eq(t.users.id, t.sources.userId))
    .where(
      and(
        eq(t.tokens.hash, new Uint8Array(digest)),
        isNull(t.tokens.revokedAt),
        eq(t.sources.kind, "listenbrainz"),
      ),
    )
    .get();
  return source ?? null;
}

export async function validateToken(context: Context<{ Bindings: Env }>) {
  const source = await authenticate(context);
  if (source === null)
    return context.json(
      { code: 401, error: "Invalid token.", valid: false },
      401,
    );
  return context.json({
    code: 200,
    message: "Token valid.",
    user_name: source.userName,
    valid: true,
  });
}

async function readListens(context: Context, now: number) {
  let json: unknown;
  try {
    json = JSON.parse(await context.req.raw.text());
  } catch {
    return fail(context, 400, "The body is not JSON.");
  }
  const parsed = v.safeParse(bodySchema, json);
  if (!parsed.success)
    return fail(context, 400, "The body is not a ListenBrainz submission.");
  const { listen_type: type, payload } = parsed.output;
  if (type !== "import" && payload.length !== 1)
    return fail(context, 400, `${type} submissions hold exactly one listen.`);
  if (payload.length === 0) return fail(context, 400, "The payload is empty.");
  if (payload.length > maxListens)
    return fail(context, 400, "The payload holds at most 1000 listens.");
  if (type === "playing_now") return { type, listens: [] };

  const listens: Array<{
    kind: string;
    sourceKey: string;
    artist: string;
    title: string;
    mbid: string | undefined;
    isrc: string | undefined;
    listenedAt: number;
  }> = [];
  const latest = now + leadSeconds;
  for (const item of payload) {
    if (
      item.listened_at === undefined ||
      item.listened_at < minListenedAt ||
      item.listened_at > latest
    )
      return fail(
        context,
        400,
        "listened_at must sit between 2005-01-01 and one day from now.",
      );
    const info = item.track_metadata.additional_info;
    listens.push({
      kind: "listenbrainz",
      // Track aliases are shared by every user, so the key comes only from
      // text the submitter cannot split ambiguously. A client-supplied MBID
      // would let one user pin another user's plays of that MBID.
      sourceKey: JSON.stringify([
        item.track_metadata.artist_name,
        item.track_metadata.track_name,
      ]),
      artist: item.track_metadata.artist_name,
      title: item.track_metadata.track_name,
      mbid: info?.recording_mbid,
      isrc: info?.isrc,
      listenedAt: item.listened_at,
    });
  }
  return { type, listens };
}

export async function submitListens(context: Context<{ Bindings: Env }>) {
  const source = await authenticate(context);
  if (source === null) return fail(context, 401, "Invalid token.");
  const now = Math.floor(Date.now() / 1000);
  const body = await readListens(context, now);
  if (body instanceof Response) return body;

  const db = database(context.env.DB);
  let inserted = 0;
  if (body.listens.length > 0) {
    const inputs = body.listens.map((listen) => ({
      ...listen,
      userId: source.userId,
      sourceId: source.sourceId,
    }));
    inserted = await storeListens(db, inputs, "listenbrainz");
    await markDuplicates(
      db,
      source.userId,
      Math.min(...body.listens.map((listen) => listen.listenedAt)),
      Math.max(...body.listens.map((listen) => listen.listenedAt)),
    );
  }
  await db.batch([
    db
      .update(t.sources)
      .set({
        lastOkAt: now,
        playCount: sql`${t.sources.playCount} + ${inserted}`,
      })
      .where(eq(t.sources.id, source.sourceId)),
    db
      .update(t.tokens)
      .set({ lastUsedAt: now })
      .where(eq(t.tokens.id, source.tokenId)),
  ]);
  return context.json({ status: "ok" });
}
