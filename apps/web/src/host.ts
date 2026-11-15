import { createMiddleware } from "hono/factory";

const legacyHost = "music.rising.sh";
const canonicalOrigin = "https://earshot.rising.sh";

// Machine traffic keeps working on the old host with no redirect: the JSON
// API and upload endpoint, the scrobbler routes, the sign-in callbacks, the
// profile's JSON and card, and the WebSocket upgrades. A page GET or HEAD
// moves to the canonical host.
const machinePrefixes = ["/api/", "/1/", "/auth/"];

function machinePath(path: string) {
  return (
    machinePrefixes.some((prefix) => path.startsWith(prefix)) ||
    (path.startsWith("/u/") &&
      (path.endsWith(".json") || path.endsWith(".svg")))
  );
}

export const legacyHostRedirect = createMiddleware(async (context, next) => {
  const url = new URL(context.req.url);
  if (
    url.hostname !== legacyHost ||
    (context.req.method !== "GET" && context.req.method !== "HEAD") ||
    context.req.header("upgrade") === "websocket" ||
    machinePath(url.pathname)
  )
    return next();
  return context.redirect(
    `${canonicalOrigin}${url.pathname}${url.search}`,
    301,
  );
});
