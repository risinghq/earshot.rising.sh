import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Period, PeriodStats } from "./types";
import { getStats } from "./aggregate";
import {
  beginGithub,
  githubCallback,
  sessionUser,
  type SignedInUser,
} from "./auth";
import { legacyHostRedirect } from "./host";
import { renderCard, type CardTheme } from "./card";
import { pullDueSources } from "./cron";
import { refreshCatalog } from "./play/refresh";
import { sourceNames } from "./names";
import { DayBars } from "./ui/bars";
import { EmptyState } from "./ui/empty";
import { RankedList } from "./ui/ranked";
import { Section } from "./ui/section";
import { Segmented } from "./ui/segmented";
import { Page } from "./ui/shell";
import { PillLink } from "./ui/pill";
import { Stats } from "./ui/stat";
import { submitListens, validateToken } from "./listenbrainz";
import { friendsApp } from "./friends";
import { groupsApp } from "./groups";
import { settingsApp } from "./settings";
import { beginSpotify, spotifyCallback } from "./spotify";
import { adminApp } from "./admin";
import { listCategories, type Category } from "./play/catalog";
import { playApp } from "./play/routes";
import { uploadPlays } from "./upload";

const periods: Period[] = ["week", "month", "all"];

function readPeriod(value: string | undefined): Period | null {
  return value === undefined
    ? "week"
    : periods.includes(value as Period)
      ? (value as Period)
      : null;
}

function readCardSize(value: string | undefined): number | null {
  if (value === undefined) return 5;
  if (!/^(?:[1-9]|10)$/.test(value)) return null;
  return Number(value);
}

function readTheme(value: string | undefined): CardTheme | null {
  if (value === undefined) return "light";
  return value === "light" || value === "dark" ? value : null;
}

async function findUser(db: D1Database, name: string) {
  return db
    .prepare(
      `SELECT id, name,
       (
         SELECT group_concat(kind) FROM sources WHERE user_id = users.id
       ) AS kinds
       FROM users
       WHERE name = ?1 COLLATE NOCASE AND is_public = 1 AND admin_hidden = 0`,
    )
    .bind(name)
    .first<{
      id: number;
      name: string;
      kinds: string | null;
    }>();
}

async function getSnapshot(
  env: Env,
  user: { id: number; name: string },
  period: Period,
  now: number,
) {
  const key = `snap:${user.id}:${period}`;
  if (env.CACHE) {
    let cached: PeriodStats | null = null;
    try {
      cached = await env.CACHE.get<PeriodStats>(key, "json");
    } catch {
      cached = null;
    }
    if (
      cached &&
      cached.updated_at > now - (period === "all" ? 6 * 3600 : 15 * 60)
    )
      return cached;
  }
  const snapshot = await getStats(env.DB, user.id, user.name, period, now);
  if (env.CACHE) {
    await env.CACHE.put(key, JSON.stringify(snapshot), {
      expirationTtl: period === "all" ? 6 * 3600 : 15 * 60,
    }).catch(() => undefined);
  }
  return snapshot;
}

const periodNames: Record<Period, string> = {
  week: "Week",
  month: "Month",
  all: "All time",
};

const dailyBars = 30;

function sourceLine(kinds: string | null) {
  const names = new Set(
    (kinds?.split(",") ?? []).map((kind) => sourceNames[kind] ?? kind),
  );
  return names.size === 0 ? "None" : [...names].sort().join(", ");
}

function homePage(user: SignedInUser | null, categories: Category[]) {
  const playable = categories.filter(
    (category) => category.feed !== "mine" || user !== null,
  );
  return Page({
    title: "Home",
    user,
    children: (
      <>
        <div class="hero">
          <div class="hero-lead">
            <h1>How well do you know your music?</h1>
            <p>
              Ten clips, fifteen seconds each. Name the song before the time
              runs out, alone, in a room with friends, or against a stranger.
            </p>
            <div class="hero-actions">
              <PillLink href="/play" variant="primary" large>
                Play a game
              </PillLink>
              <PillLink href="/play/board" large>
                Points board
              </PillLink>
            </div>
          </div>
          <div class="hero-cats">
            <p class="label">Start with a category</p>
            <div class="chips">
              {playable.map((category) =>
                category.feed === "mine" ? (
                  <a class="chip" href="/play" key={category.slug}>
                    {category.name}
                  </a>
                ) : (
                  <form method="post" action="/play" key={category.slug}>
                    <input
                      type="hidden"
                      name="category"
                      value={category.slug}
                    />
                    <input type="hidden" name="mode" value="choices" />
                    <button class="chip" type="submit">
                      {category.name}
                    </button>
                  </form>
                ),
              )}
            </div>
            <p class="hint">
              A chip starts a solo game with four choices. More modes and
              categories are on the <a href="/play">play page</a>.
            </p>
          </div>
        </div>
        <div class="duo">
          <Section title="Groups">
            <p class="muted">
              Friends make a group together, and the group's playlist blends
              what each member plays into a list that opens on YouTube.
            </p>
            <div>
              <PillLink href="/groups">Open your groups</PillLink>
            </div>
          </Section>
          <Section title="Your listening">
            {user === null ? (
              <>
                <p class="muted">
                  Sign in with GitHub and Earshot stores the plays you connect
                  from Spotify and YouTube Music. Your top tracks, top artists
                  and plays per day appear on a public page at{" "}
                  <code>/u/name</code>.
                </p>
                <div>
                  <PillLink href="/auth/github" variant="primary">
                    Sign in with GitHub
                  </PillLink>
                </div>
                <p class="hint">
                  Profiles are public until you hide them in settings.
                </p>
              </>
            ) : (
              <>
                <p class="muted">
                  Signed in as <b>{user.name}</b>.
                </p>
                <div class="modes">
                  <PillLink
                    href={`/u/${encodeURIComponent(user.name)}`}
                    variant="primary"
                  >
                    Your profile
                  </PillLink>
                  <PillLink href="/settings">Settings</PillLink>
                </div>
              </>
            )}
          </Section>
        </div>
      </>
    ),
  });
}

function profilePage(
  snapshot: PeriodStats,
  origin: string,
  kinds: string | null,
  user: SignedInUser | null,
  relation: "friends" | "sent" | "none" | "self" | "out",
) {
  const days = snapshot.daily.slice(-dailyBars);
  const cardUrl = `${origin}/u/${encodeURIComponent(snapshot.user.name)}.svg`;
  const updated = new Date(snapshot.updated_at * 1000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  const periodNote = periodNames[snapshot.period];
  return Page({
    title: snapshot.user.name,
    head: (
      <>
        <meta
          property="og:title"
          content={`${snapshot.user.name}'s listening profile`}
        />
        <meta property="og:image" content={cardUrl} />
      </>
    ),
    user,
    footer: (
      <>
        <a
          href={`/u/${encodeURIComponent(snapshot.user.name)}.json?period=${snapshot.period}`}
        >
          Data as JSON
        </a>
        {relation === "friends" && <a href="/friends">Friends</a>}
        {relation === "sent" && <span class="meta">Request sent</span>}
        {relation === "none" && (
          <form method="post" action="/friends/request">
            <input type="hidden" name="name" value={snapshot.user.name} />
            <input
              type="hidden"
              name="next"
              value={`/u/${encodeURIComponent(snapshot.user.name)}`}
            />
            <button class="pill small" type="submit">
              Add friend
            </button>
          </form>
        )}
      </>
    ),
    children: (
      <>
        <div class="page-head">
          <h1>{snapshot.user.name}</h1>
          <p class="meta">
            Sources: {sourceLine(kinds)}. Updated{" "}
            <time datetime={new Date(snapshot.updated_at * 1000).toISOString()}>
              {updated} UTC
            </time>
            .
          </p>
        </div>
        <Segmented
          label="Time period"
          options={periods.map((period) => ({
            label: periodNames[period],
            href: `?period=${period}`,
            current: snapshot.period === period,
          }))}
        />
        <Stats
          items={[
            { label: "Plays", value: snapshot.plays },
            { label: "Tracks", value: snapshot.unique_tracks },
            { label: "Artists", value: snapshot.unique_artists },
          ]}
        />
        {snapshot.plays === 0 ? (
          <EmptyState
            title="No plays in this period"
            body="Plays appear here once a connected source reports them. Try a longer period."
          />
        ) : (
          <>
            <div class="duo">
              <Section title="Top tracks" aside={periodNote}>
                <RankedList
                  items={snapshot.top_tracks.map((item) => ({
                    title: item.title,
                    subtitle: item.artist,
                    plays: item.plays,
                  }))}
                />
              </Section>
              <Section title="Top artists" aside={periodNote}>
                <RankedList
                  items={snapshot.top_artists.map((item) => ({
                    title: item.artist,
                    plays: item.plays,
                  }))}
                />
              </Section>
            </div>
            <Section
              title="Plays per day"
              aside={
                snapshot.daily.length > dailyBars
                  ? `Latest ${dailyBars} days with plays, UTC`
                  : "Days with plays, UTC"
              }
            >
              <DayBars days={days} />
            </Section>
          </>
        )}
      </>
    ),
  });
}

export function notFoundPage(user: SignedInUser | null = null) {
  return Page({
    title: "Not found",
    user,
    children: (
      <EmptyState
        title="Page not found"
        body="The page you asked for does not exist."
        action={{ href: "/", label: "Back to the start page" }}
        heading="h1"
      />
    ),
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.use("*", legacyHostRedirect);

app.post(
  "/api/v1/upload",
  bodyLimit({
    maxSize: 256 * 1024,
    onError: (context) =>
      context.json({ error: "the body is over the 256 KiB limit" }, 413),
  }),
  uploadPlays,
);

// Pano Scrobbler joins the configured server to "1/" and the route name, so a
// server entered as https://earshot.rising.sh or .../1 both reach these routes.
app.on(
  "POST",
  ["/1/submit-listens", "/1/1/submit-listens"],
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (context) =>
      context.json(
        { code: 413, error: "The body is over the 512 KiB limit." },
        413,
      ),
  }),
  submitListens,
);

app.on("GET", ["/1/validate-token", "/1/1/validate-token"], validateToken);

app.all("/1/*", (context) =>
  context.json({ code: 404, error: "Not found." }, 404),
);

app.get("/", async (context) => {
  const user = await sessionUser(context);
  const categories = await listCategories(context.env.DB);
  return context.html(homePage(user, categories));
});

app.get("/auth/github", (context) => beginGithub(context));

app.get("/auth/github/callback", (context) => githubCallback(context));

app.get("/auth/spotify", (context) => beginSpotify(context));

app.get("/auth/spotify/callback", (context) => spotifyCallback(context));

app.route("/settings", settingsApp);

app.route("/friends", friendsApp);

app.route("/groups", groupsApp);

app.route("/play", playApp);

app.route("/admin", adminApp);

app.get("/party", (context) => context.redirect("/groups", 301));

app.get("/u/:path", async (context) => {
  const path = context.req.param("path") ?? "";
  const format = path.endsWith(".json")
    ? "json"
    : path.endsWith(".svg")
      ? "svg"
      : "html";
  const name =
    format === "json"
      ? path.slice(0, -5)
      : format === "svg"
        ? path.slice(0, -4)
        : path;
  const badRequest = (message: string) =>
    format === "json"
      ? context.json({ error: message }, 400)
      : context.text(message, 400);
  const period = readPeriod(context.req.query("period"));
  if (!period) return badRequest("period must be week, month or all");
  let card: { size: number; theme: CardTheme } | undefined;
  if (format === "svg") {
    const size = readCardSize(context.req.query("n"));
    if (size === null) return badRequest("n must be between 1 and 10");
    const theme = readTheme(context.req.query("theme"));
    if (theme === null) return badRequest("theme must be light or dark");
    card = { size, theme };
  }
  if (!name)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.html(notFoundPage(await sessionUser(context)), 404);
  const user = await findUser(context.env.DB, name);
  if (!user)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.html(notFoundPage(await sessionUser(context)), 404);
  const snapshot = await getSnapshot(
    context.env,
    user,
    period,
    Math.floor(Date.now() / 1000),
  );
  if (format === "html") {
    const viewer = await sessionUser(context);
    let relation: "friends" | "sent" | "none" | "self" | "out" = "out";
    if (viewer !== null && viewer.id === user.id) relation = "self";
    else if (viewer !== null) {
      const [friends, sent] = await context.env.DB.batch([
        context.env.DB.prepare(
          `SELECT 1 AS yes FROM friendships
           WHERE user_id = ?1 AND friend_id = ?2`,
        ).bind(viewer.id, user.id),
        context.env.DB.prepare(
          `SELECT 1 AS yes FROM friend_requests
           WHERE from_user = ?1 AND to_user = ?2`,
        ).bind(viewer.id, user.id),
      ]);
      relation =
        friends.results.length > 0
          ? "friends"
          : sent.results.length > 0
            ? "sent"
            : "none";
    }
    return context.html(
      profilePage(
        snapshot,
        new URL(context.req.url).origin,
        user.kinds,
        viewer,
        relation,
      ),
    );
  }
  context.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'",
  );
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Cache-Control", "public, max-age=900");
  if (card) {
    context.header("Content-Type", "image/svg+xml");
    return context.body(renderCard(snapshot, card.size, card.theme));
  }
  context.header("Access-Control-Allow-Origin", "*");
  return context.json(snapshot);
});

app.notFound(async (context) =>
  context.html(notFoundPage(await sessionUser(context)), 404),
);

export async function scheduled(_controller: ScheduledController, env: Env) {
  await pullDueSources(env);
  await refreshCatalog(env);
}
