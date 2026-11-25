import { Hono } from "hono";
import { csrf } from "hono/csrf";
import type { Env } from "../env";
import { artistApp } from "./artist/routes";
import { boardApp } from "./board/routes";
import { hubApp } from "./hub/routes";
import { matchApp } from "./match/routes";
import { reportApp } from "./report";
import { roomApp } from "./room/routes";
import { soloApp } from "./solo/routes";

export { renderHub } from "./hub/routes";

export const playApp = new Hono<{ Bindings: Env }>();

playApp.use("*", csrf());

for (const app of [hubApp, roomApp, matchApp, boardApp, artistApp, reportApp])
  playApp.route("/", app);
// Last: the solo game's /:id routes would take any single-segment path above.
playApp.route("/", soloApp);
