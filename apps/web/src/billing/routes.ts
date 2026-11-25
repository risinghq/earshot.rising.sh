import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import type { Env } from "../env";
import { database, t } from "../platform/db";

// Polar follows the Standard Webhooks scheme: the signature covers
// `id.timestamp.body` and arrives in webhook-signature as space-separated
// `v1,<base64-hmac>` pairs. A signature older than this is refused, so a
// recorded request cannot be replayed later.
const toleranceSeconds = 300;

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

export async function polarSignatureOk(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  nowSeconds: number,
) {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const stamp = Number(timestamp);
  if (!Number.isInteger(stamp)) return false;
  if (Math.abs(nowSeconds - stamp) > toleranceSeconds) return false;
  const offered = signature
    .split(" ")
    .map((part) => part.split(",", 2))
    .filter(([version]) => version === "v1")
    .map(([, value]) => value);
  if (offered.length === 0) return false;
  // A dashboard secret is `whsec_` plus the base64 key. `polar webhook
  // listen` prints a bare secret and signs with its UTF-8 bytes.
  let keyBytes: Uint8Array;
  if (secret.startsWith("whsec_")) {
    try {
      keyBytes = Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0));
    } catch {
      return false;
    }
  } else {
    keyBytes = new TextEncoder().encode(secret);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = b64(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${stamp}.${body}`),
    ),
  );
  return offered.some((value) => value === expected);
}

// The settings page opens the checkout link with `?reference_id=<user id>`.
// Polar stores that in the checkout's metadata and copies it onto the order.
const PolarEvent = v.object({
  type: v.string(),
  data: v.object({
    metadata: v.nullish(
      v.object({ reference_id: v.nullish(v.union([v.string(), v.number()])) }),
    ),
  }),
});

export const billingApp = new Hono<{ Bindings: Env }>();

// Polar posts here; the signature, not a session, proves the event. A bad or
// unsigned body gets a 403 so Polar retries with the real one later.
billingApp.post("/webhook", async (context) => {
  const secret = context.env.POLAR_WEBHOOK_SECRET;
  if (!secret) return context.text("billing is not configured", 503);
  const body = await context.req.text();
  const ok = await polarSignatureOk(
    secret,
    {
      id: context.req.header("webhook-id"),
      timestamp: context.req.header("webhook-timestamp"),
      signature: context.req.header("webhook-signature"),
    },
    body,
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return context.text("bad signature", 403);
  let parsed: ReturnType<typeof v.safeParse<typeof PolarEvent>>;
  try {
    parsed = v.safeParse(PolarEvent, JSON.parse(body));
  } catch {
    return context.text("bad event", 400);
  }
  if (!parsed.success) return context.text("bad event", 400);
  const event = parsed.output;
  const userId = Number(event.data.metadata?.reference_id);
  if (!Number.isInteger(userId) || userId <= 0) return context.text("ok");
  // order.paid only fires once the payment settles; order.refunded takes the
  // tier back. Other events are acknowledged and ignored.
  const tier =
    event.type === "order.paid"
      ? "paid"
      : event.type === "order.refunded"
        ? "free"
        : null;
  if (tier !== null)
    await database(context.env.DB)
      .update(t.users)
      .set({ tier })
      .where(eq(t.users.id, userId));
  return context.text("ok");
});
