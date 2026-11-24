import type { MiddlewareHandler } from "hono";
import { sessionUser, type SignedInUser } from "./auth";
import type { Env } from "../env";
import { SignInCard } from "../ui/empty";
import { Page, type NavSection } from "../ui/shell";

export interface SignInCopy {
  title: string;
  heading: string;
  body: string;
  nav?: NavSection;
}

export function signInPage(copy: SignInCopy, next: string) {
  return Page({
    title: copy.title,
    nav: copy.nav,
    children: <SignInCard title={copy.heading} body={copy.body} next={next} />,
  });
}

export function memberOnly(copy: SignInCopy): MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: SignedInUser };
}> {
  return async (context, next) => {
    const user = await sessionUser(context);
    if (user === null)
      return context.req.method === "POST"
        ? context.text("Forbidden", 403)
        : context.html(signInPage(copy, context.req.path));
    context.set("user", user);
    await next();
  };
}
