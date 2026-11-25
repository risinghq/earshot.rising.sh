import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { sessionUser } from "../account/auth";
import { notFoundPage } from "../ui/not-found";
import { categoriesApp } from "./categories";
import { reportsApp } from "./reports";
import { adminIds, type AdminEnv } from "./shell";
import { tracksApp } from "./tracks";
import { usersApp } from "./users";

export const adminApp = new Hono<AdminEnv>();

// A visitor who is not an admin gets the site's 404, so the section does not
// show that it exists.
adminApp.use("*", async (context, next) => {
  const user = await sessionUser(context);
  if (user === null || !adminIds(context.env).has(user.githubId))
    return context.html(notFoundPage(user), 404);
  context.set("admin", user);
  await next();
});

adminApp.use("*", csrf());

adminApp
  .route("/", categoriesApp)
  .route("/", tracksApp)
  .route("/", reportsApp)
  .route("/", usersApp);
