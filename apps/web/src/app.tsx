import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, Period, PeriodStats } from "./types";
import { getStats } from "./aggregate";
import {
  beginSignIn,
  returnPath,
  sessionUser,
  signInCallback,
  type SignedInUser,
} from "./auth";
import { signInPage } from "./sign-in";
import { legacyHostRedirect } from "./host";
import { renderCard, type CardTheme } from "./card";
import { pullDueSources } from "./cron";
import { fillImages } from "./images";
import { refreshCatalog } from "./play/refresh";
import { warmChartCache } from "./play/catalog";
import { sourceNames } from "./names";
import { DayBars, dayBuckets } from "./ui/bars";
import { EmptyState } from "./ui/empty";
import { Cover, Monogram, soundMark } from "./ui/person";
import { Segmented } from "./ui/segmented";
import { Page } from "./ui/shell";
import { submitListens, validateToken } from "./listenbrainz";
import { friendsApp } from "./friends";
import { groupsApp } from "./groups";
import { settingsApp } from "./settings";
import { beginSpotify, spotifyCallback } from "./spotify";
import { adminApp } from "./admin";
import { playApp, renderHub } from "./play/routes";
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

// Bars per chart: a week shows each day; month and all time show the last
// 30 days.
const chartDays: Record<Period, number> = { week: 7, month: 30, all: 30 };

const emptyTitles: Record<Period, string> = {
  week: "No plays in the last 7 days",
  month: "No plays in the last 30 days",
  all: "No plays yet",
};

function sourceList(kinds: string | null) {
  const names = new Set(
    (kinds?.split(",") ?? []).map((kind) => sourceNames[kind] ?? kind),
  );
  return [...names].sort();
}

const updatedText = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

const trackSeed = (track: { title: string; artist: string }) =>
  `${track.title} ${track.artist}`;

type Relation = "friends" | "sent" | "none" | "self" | "out";

async function relationTo(
  db: D1Database,
  viewer: SignedInUser | null,
  userId: number,
): Promise<Relation> {
  if (viewer === null) return "out";
  if (viewer.id === userId) return "self";
  const [friends, sent] = await db.batch([
    db
      .prepare(
        `SELECT 1 AS yes FROM friendships
         WHERE user_id = ?1 AND friend_id = ?2`,
      )
      .bind(viewer.id, userId),
    db
      .prepare(
        `SELECT 1 AS yes FROM friend_requests
         WHERE from_user = ?1 AND to_user = ?2`,
      )
      .bind(viewer.id, userId),
  ]);
  if (friends.results.length > 0) return "friends";
  return sent.results.length > 0 ? "sent" : "none";
}

function ProfileActions({
  name,
  period,
  relation,
}: {
  name: string;
  period: Period;
  relation: Relation;
}) {
  const path = `/u/${encodeURIComponent(name)}`;
  return (
    <div class="actions" id="profile-actions">
      {relation === "friends" && (
        <a class="btn is-sm" href="/friends">
          Friends
        </a>
      )}
      {relation === "sent" && (
        <span class="btn is-sm" aria-disabled="true">
          Request sent
        </span>
      )}
      {relation === "none" && (
        <form
          method="post"
          action="/friends/request"
          data-inline="profile-actions"
        >
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="next" value={path} />
          <button class="btn is-sm is-primary" type="submit">
            Add friend
          </button>
        </form>
      )}
      <a class="btn is-sm" href={`${path}.json?period=${period}`}>
        <span class="code-mark" aria-hidden="true">
          {"{ }"}
        </span>
        Data as JSON
      </a>
    </div>
  );
}

// A cover shows the Deezer image when one was found, over a colour tile
// hashed from a seed: a track's own title and artist, and for an artist the
// seed of their top track, so an artist's disc matches that track's cover.
function TopList({
  title,
  rows,
  artists = false,
}: {
  title: string;
  rows: {
    title: string;
    artist?: string;
    plays: number;
    // Snapshots cached before images existed carry none.
    image?: string | null;
    seed: string;
  }[];
  artists?: boolean;
}) {
  const max = Math.max(1, rows[0]?.plays ?? 1);
  return (
    <section class={artists ? "top-card is-artists" : "top-card"}>
      <h2>{title}</h2>
      <ol>
        {rows.map((row, index) => {
          const meter = (
            <span class="meter" aria-hidden="true">
              <span style={`--pct: ${((row.plays / max) * 100).toFixed(1)}%`} />
            </span>
          );
          return (
            <li class="trow">
              <span class="rank">{index + 1}</span>
              <Cover seed={row.seed} src={row.image} disc={artists} />
              <div class="body">
                <div class="line">
                  <span class="title">{row.title}</span>
                  <b class="count">{row.plays}</b>
                </div>
                {row.artist !== undefined && (
                  <span class="artist">{row.artist}</span>
                )}
                {meter}
              </div>
              <div class="stat is-wide" aria-hidden="true">
                {meter}
                <b>{row.plays}</b>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function profilePage(
  snapshot: PeriodStats,
  origin: string,
  kinds: string | null,
  user: SignedInUser | null,
  relation: Relation,
) {
  const name = snapshot.user.name;
  const cardUrl = `${origin}/u/${encodeURIComponent(name)}.svg`;
  const updatedDay = new Date(snapshot.updated_at * 1000)
    .toISOString()
    .slice(0, 10);
  const days = dayBuckets(
    snapshot.daily,
    updatedDay,
    chartDays[snapshot.period],
  );
  const empty = snapshot.plays === 0;
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
    children: (
      <>
        <section class="profile-hero">
          <div class="profile-side">
            <div class="profile-id">
              <Monogram name={name} />
              <div>
                <h1 class="profile-name">{name}</h1>
                <div class="profile-meta">
                  {sourceList(kinds).map((source) => (
                    <span class="source-pill">{source}</span>
                  ))}
                  <span class="updated">
                    Updated{" "}
                    <time
                      datetime={new Date(
                        snapshot.updated_at * 1000,
                      ).toISOString()}
                    >
                      {updatedText(snapshot.updated_at)} UTC
                    </time>
                  </span>
                </div>
              </div>
            </div>
            {!empty && (
              <dl class="stage-stats">
                {(
                  [
                    ["Plays", snapshot.plays],
                    ["Tracks", snapshot.unique_tracks],
                    ["Artists", snapshot.unique_artists],
                  ] as const
                ).map(([label, value]) => (
                  <div>
                    <dt>{label}</dt>
                    <dd>{value.toLocaleString("en-US")}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div class="profile-main">
            <Segmented
              label="Time period"
              stage
              swap="main"
              options={periods.map((period) => ({
                label: periodNames[period],
                href: `?period=${period}`,
                current: snapshot.period === period,
              }))}
            />
            {empty ? (
              <div class="profile-empty">
                <h2>{emptyTitles[snapshot.period]}</h2>
                <p>
                  Plays appear here once a connected source reports them.
                  {snapshot.period !== "all" &&
                    " A longer period may hold some."}
                </p>
                {snapshot.period !== "all" && (
                  <div class="actions" data-swap="main">
                    {snapshot.period === "week" && (
                      <a class="btn is-stage" href="?period=month">
                        See Month
                      </a>
                    )}
                    <a
                      class={
                        snapshot.period === "week"
                          ? "btn is-stage-2"
                          : "btn is-stage"
                      }
                      href="?period=all"
                    >
                      All time
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <div class="stage-chart">
                <div class="chart-head">
                  <span>Plays per day</span>
                  <span>
                    {snapshot.period === "week" ? "UTC" : "Last 30 days · UTC"}
                  </span>
                </div>
                <DayBars days={days} />
              </div>
            )}
          </div>
        </section>
        <div class="note-row">
          {!empty && (
            <p class="for-you-note">
              {soundMark}
              These plays tune {name}'s For you mix.
            </p>
          )}
          <ProfileActions
            name={name}
            period={snapshot.period}
            relation={relation}
          />
        </div>
        {!empty && (
          <div class="top-pair">
            <TopList
              title="Top tracks"
              rows={snapshot.top_tracks.map((item) => ({
                ...item,
                seed: trackSeed(item),
              }))}
            />
            <TopList
              title="Top artists"
              artists
              rows={snapshot.top_artists.map((item) => {
                const top = snapshot.top_tracks.find(
                  (track) => track.artist === item.artist,
                );
                return {
                  title: item.artist,
                  plays: item.plays,
                  image: item.image,
                  seed: top ? trackSeed(top) : item.artist,
                };
              })}
            />
          </div>
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

app.get("/", (context) => renderHub(context));

app.get("/sign-in", async (context) => {
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
  app.get(`/auth/${provider}`, (context) => beginSignIn(context, provider));
  app.get(`/auth/${provider}/callback`, (context) =>
    signInCallback(context, provider),
  );
}

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
  // Each D1 read is a round trip to the database's region, so reads that do
  // not depend on each other run together.
  const [user, viewer] = await Promise.all([
    findUser(context.env.DB, name),
    format === "html" ? sessionUser(context) : null,
  ]);
  if (!user)
    return format === "json"
      ? context.json({ error: "not found" }, 404)
      : context.html(notFoundPage(viewer), 404);
  const now = Math.floor(Date.now() / 1000);
  if (format === "html") {
    const [snapshot, relation] = await Promise.all([
      getSnapshot(context.env, user, period, now),
      relationTo(context.env.DB, viewer, user.id),
    ]);
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
  const snapshot = await getSnapshot(context.env, user, period, now);
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
  await warmChartCache(env);
  await fillImages(env);
}
