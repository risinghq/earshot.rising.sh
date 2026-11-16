import type { MiddlewareHandler } from "hono";
import { sessionUser, type SignedInUser } from "./auth";
import type { Env } from "./types";
import { EmptyState } from "./ui/empty";
import { Page } from "./ui/shell";

function signInPage(title: string, body: string) {
  return Page({
    title,
    children: (
      <EmptyState
        heading="h1"
        title={title}
        body={body}
        action={{ href: "/auth/github", label: "Sign in" }}
      />
    ),
  });
}

export function memberOnly(
  title: string,
  body: string,
): MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}> {
  return async (context, next) => {
    const user = await sessionUser(context);
    if (user === null)
      return context.req.method === "POST"
        ? context.text("Forbidden", 403)
        : context.html(signInPage(title, body));
    context.set("user", user);
    await next();
  };
}
