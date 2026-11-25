import { Hono } from "hono";
import { sessionUser } from "./account/auth";
import { accountApp } from "./account/routes";
import { settingsApp } from "./account/settings";
import { adminApp } from "./admin/routes";
import { billingApp } from "./billing/routes";
import type { Env } from "./env";
import { fetchApp } from "./fetch/routes";
import { listeningApp } from "./listening/routes";
import { legacyHostRedirect } from "./platform/host";
import { playApp, renderHub } from "./play/routes";
import { profileApp } from "./profile/routes";
import { friendsApp } from "./social/friends";
import { groupsApp } from "./social/groups";
import { notFoundPage } from "./ui/not-found";

export const app = new Hono<{ Bindings: Env }>();

app.use("*", legacyHostRedirect);

app.route("/", listeningApp);

app.get("/", (context) => renderHub(context));

app.route("/", accountApp);

app.route("/settings", settingsApp);

app.route("/friends", friendsApp);

app.route("/groups", groupsApp);

app.route("/play", playApp);

app.route("/admin", adminApp);

app.route("/billing", billingApp);

app.route("/fetch", fetchApp);

app.get("/party", (context) => context.redirect("/groups", 301));

app.route("/u", profileApp);

app.notFound(async (context) =>
  context.html(notFoundPage(await sessionUser(context)), 404),
);
