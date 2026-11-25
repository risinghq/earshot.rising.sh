import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import type { Env } from "../env";
import { database, t } from "../platform/db";

// Stripe signs the webhook body as `t.v1` where t is the timestamp in the
// Stripe-Signature header and v1 is its HMAC-SHA256 hex. A signature older
// than this is refused, so a recorded request cannot be replayed later.
const toleranceSeconds = 300;

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export async function stripeSignatureOk(
  secret: string,
  header: string | undefined,
  body: string,
  nowSeconds: number,
) {
  if (header === undefined) return false;
  const parts = new Map(
    header
      .split(",")
      .map((part) => part.split("=", 2) as [string, string])
      .filter(([key]) => key !== ""),
  );
  const stamp = Number(parts.get("t"));
  const signatures = header
    .split(",")
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  if (!Number.isInteger(stamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - stamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${stamp}.${body}`),
    ),
  );
  return signatures.some((signature) => signature === expected);
}

const StripeEvent = v.object({
  type: v.string(),
  data: v.object({
    object: v.object({
      client_reference_id: v.nullish(v.string()),
      payment_status: v.nullish(v.string()),
      metadata: v.nullish(v.object({ user_id: v.nullish(v.string()) })),
    }),
  }),
});

export const billingApp = new Hono<{ Bindings: Env }>();

// Stripe posts here; the signature, not a session, proves the event. A bad
// or unsigned body gets a 400 so Stripe retries with the real one later.
billingApp.post("/webhook", async (context) => {
  const secret = context.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return context.text("billing is not configured", 503);
  const body = await context.req.text();
  const ok = await stripeSignatureOk(
    secret,
    context.req.header("stripe-signature"),
    body,
    Math.floor(Date.now() / 1000),
  );
  if (!ok) return context.text("bad signature", 400);
  const parsed = v.safeParse(StripeEvent, JSON.parse(body));
  if (!parsed.success) return context.text("bad event", 400);
  const event = parsed.output;
  // checkout.session.completed also fires for delayed methods while the
  // payment is still 'unpaid'; async_payment_succeeded arrives when it
  // settles. Only a settled payment earns the tier.
  if (
    (event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded") &&
    event.data.object.payment_status === "paid"
  ) {
    const ref =
      event.data.object.client_reference_id ??
      event.data.object.metadata?.user_id;
    const userId = Number(ref);
    if (Number.isInteger(userId) && userId > 0)
      await database(context.env.DB)
        .update(t.users)
        .set({ tier: "paid" })
        .where(eq(t.users.id, userId));
  }
  return context.text("ok");
});
