import { Hono } from "hono";
import type { Env } from "../env";
import { database } from "../platform/db";
import { anonOf, mergeAnonOutcomes } from "../play/game/outcomes";
import { beginSignIn, returnPath, sessionUser, signInCallback } from "./auth";
import { signInPage } from "./sign-in";

export const accountApp = new Hono<{ Bindings: Env }>();

accountApp.get("/sign-in", async (context) => {
  const next = returnPath(context.req.query("next")) ?? "/";
  if ((await sessionUser(context)) !== null) return context.redirect(next, 303);
  return context.html(
    signInPage(
      {
        title: "Sign in",
        heading: "Sign in to Earshot",
        body: "Use GitHub or Google. Both keep your profile, friends and groups.",
      },
      next,
    ),
  );
});

for (const provider of ["github", "google"] as const) {
  accountApp.get(`/auth/${provider}`, (context) =>
    beginSignIn(context, provider),
  );
  accountApp.get(`/auth/${provider}/callback`, (context) =>
    signInCallback(context, provider, async (userId) => {
      const anon = anonOf(context);
      if (anon !== null)
        await mergeAnonOutcomes(database(context.env.DB), anon, userId);
    }),
  );
}
