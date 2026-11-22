import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { csrf } from "hono/csrf";
import { notFoundPage } from "./app";
import { hasGithub, sessionUser, type SignedInUser } from "./auth";
import {
  dropTrackCaches,
  fillMissingYears,
  refreshCategorySources,
  type CategorySource,
} from "./play/refresh";
import { deezerPlaylistInfo } from "./play/sources";
import type { Env } from "./types";
import { PillButton } from "./ui/pill";
import { Page } from "./ui/shell";
import { eraLabel, generations } from "./play/eras";

type AdminContext = Context<{
  Bindings: Env;
  Variables: { admin: SignedInUser };
}>;

function adminIds(env: Env) {
  return new Set(
    (env.ADMIN_GITHUB_IDS ?? "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

interface AdminCategory {
  slug: string;
  name: string;
  feed: string;
  ref: string | null;
  position: number;
  hidden: number;
  tracks?: number;
}

async function logAction(
  db: D1Database,
  admin: SignedInUser,
  action: string,
  target: string,
  detail = "",
) {
  await db
    .prepare(
      `INSERT INTO admin_actions (github_id, action, target, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      admin.github_id,
      action,
      target,
      detail,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

async function findCategory(db: D1Database, slug: string) {
  return db
    .prepare(
      "SELECT slug, name, feed, ref, position, hidden FROM categories WHERE slug = ?1",
    )
    .bind(slug)
    .first<AdminCategory>();
}

async function field(context: AdminContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

const decadeChoices = [
  ...["1960", "1970", "1980", "1990", "2000", "2010", "2020"],
  ...Object.keys(generations),
].sort();

type AdminSection = "categories" | "reports" | "users";

function kindLabel(kind: string) {
  return kind.replaceAll("_", " ");
}

async function openReports(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM track_reports WHERE resolved_at IS NULL",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function adminNav(current: AdminSection, open: number) {
  const items: { key: AdminSection; href: string; label: string }[] = [
    { key: "categories", href: "/admin", label: "Categories" },
    { key: "reports", href: "/admin/reports", label: "Reports" },
    { key: "users", href: "/admin/users", label: "Users" },
  ];
  return (
    <nav class="admin-nav" aria-label="Admin sections">
      {items.map((item) => (
        <a
          href={item.href}
          aria-current={item.key === current ? "page" : undefined}
        >
          {item.label}
          {item.key === "reports" && open > 0 && (
            <span class="nav-badge">{open}</span>
          )}
        </a>
      ))}
    </nav>
  );
}

function adminPage(
  user: SignedInUser,
  current: AdminSection,
  open: number,
  title: string,
  caption: Child,
  children: Child,
) {
  return Page({
    title: `${title} · Admin`,
    user,
    children: (
      <div class="admin dense">
        {adminNav(current, open)}
        <div class="admin-main">
          <div class="page-head">
            <h1>{title}</h1>
            <p class="meta">{caption}</p>
          </div>
          {children}
        </div>
      </div>
    ),
  });
}

function Group({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: Child;
  children: Child;
}) {
  return (
    <section class="group">
      <div class="group-head">
        <h2>{title}</h2>
        {aside && <small class="label">{aside}</small>}
      </div>
      {children}
    </section>
  );
}

function indexPage(
  user: SignedInUser,
  categories: AdminCategory[],
  open: number,
) {
  return adminPage(
    user,
    "categories",
    open,
    "Categories",
    `${categories.length} ${categories.length === 1 ? "category" : "categories"} on /play.`,
    <>
      <Group title="Categories">
        {categories.length === 0 ? (
          <div class="group-row">
            <p class="meta">No categories yet. Create the first one below.</p>
          </div>
        ) : (
          categories.map((category) => (
            <div class="group-row" key={category.slug}>
              <span class="row-text">
                <b>
                  <a href={`/admin/categories/${category.slug}`}>
                    {category.name}
                  </a>
                </b>
                <small>
                  {category.slug} · order {category.position}
                </small>
              </span>
              <span class="badges">
                <span class="badge">{kindLabel(category.feed)}</span>
                {category.hidden === 1 && (
                  <span class="badge accent">hidden</span>
                )}
                <span class="badge">{category.tracks} tracks</span>
              </span>
            </div>
          ))
        )}
      </Group>
      <Group title="New category">
        <form method="post" action="/admin/categories">
          <div class="group-row">
            <span class="row-text">
              <b>
                <label for="slug">Slug</label>
              </b>
              <small>Lowercase letters, digits and hyphens.</small>
            </span>
            <span class="row-side">
              <input
                id="slug"
                name="slug"
                type="text"
                required
                spellcheck={false}
                autocomplete="off"
              />
            </span>
          </div>
          <div class="group-row">
            <span class="row-text">
              <b>
                <label for="name">Name</label>
              </b>
              <small>Shown on /play and in admin.</small>
            </span>
            <span class="row-side">
              <input id="name" name="name" type="text" required />
            </span>
          </div>
          <div class="group-row">
            <span class="row-side">
              <PillButton variant="primary">Create category</PillButton>
            </span>
          </div>
        </form>
      </Group>
    </>,
  );
}

function categoryPage(
  user: SignedInUser,
  category: AdminCategory,
  sources: CategorySource[],
  pending: { ref: string; title: string; owner: string; tracks: number } | null,
  open: number,
) {
  return adminPage(
    user,
    "categories",
    open,
    category.name,
    `${category.slug} · order ${category.position}${category.hidden === 1 ? " · hidden" : ""}`,
    <>
      <Group title="Category">
        <form id="category-save" method="post" action="/admin/categories/save">
          <input type="hidden" name="slug" value={category.slug} />
          <div class="group-row">
            <span class="row-text">
              <b>
                <label for="name">Name</label>
              </b>
              <small>Shown on /play and in admin.</small>
            </span>
            <span class="row-side">
              <input id="name" name="name" type="text" value={category.name} />
            </span>
          </div>
          <div class="group-row">
            <span class="row-text">
              <b>
                <label for="position">Order</label>
              </b>
              <small>Categories sort by this number on /play.</small>
            </span>
            <span class="row-side">
              <input
                id="position"
                name="position"
                type="number"
                value={category.position}
              />
            </span>
          </div>
          <div class="group-row">
            <span class="row-text">
              <b>
                <label for="hidden">Hidden</label>
              </b>
              <small>
                A hidden category leaves /play; its games show the unavailable
                page.
              </small>
            </span>
            <span class="row-side">
              <input
                id="hidden"
                name="hidden"
                type="checkbox"
                class="switch"
                checked={category.hidden === 1}
              />
            </span>
          </div>
        </form>
        <div class="group-row">
          <span class="row-side">
            <button class="pill primary" type="submit" form="category-save">
              Save category
            </button>
            <form method="post" action="/admin/refresh">
              <input type="hidden" name="slug" value={category.slug} />
              <button class="pill outline" type="submit">
                Refresh sources
              </button>
            </form>
            <a
              class="pill ghost"
              href={`/admin/categories/${category.slug}/tracks`}
            >
              Tracks
            </a>
          </span>
        </div>
      </Group>
      <Group title="Sources" aside={`${sources.length}`}>
        {sources.length === 0 && (
          <div class="group-row">
            <p class="meta">No sources yet. Add a Deezer playlist below.</p>
          </div>
        )}
        {sources.map((source) => (
          <div class="group-row" key={source.id}>
            <span class="row-text">
              <b>{source.title ?? `playlist ${source.ref}`}</b>
              <small>
                {source.ref}
                {source.decade !== null && ` · ${eraLabel(source.decade)}`}
                {source.tracks_count !== null &&
                  ` · ${source.tracks_count} tracks`}
                {source.refreshed_at !== null &&
                  ` · refreshed ${new Date(source.refreshed_at * 1000)
                    .toISOString()
                    .slice(0, 10)}`}
              </small>
            </span>
            <span class="badges">
              <span class="badge">{kindLabel(source.kind)}</span>
            </span>
            <form
              method="post"
              action="/admin/sources/remove"
              onsubmit="return confirm('Remove this source?')"
            >
              <input type="hidden" name="id" value={source.id} />
              <input type="hidden" name="category" value={category.slug} />
              <PillButton variant="danger" small>
                Remove
              </PillButton>
            </form>
          </div>
        ))}
        {pending !== null && (
          <div class="group-row">
            <div class="notice" aria-label="Playlist found">
              <p>
                <b>{pending.title}</b> by {pending.owner || "unknown"} ·{" "}
                {pending.tracks} tracks
              </p>
              <form method="post" action="/admin/sources">
                <input type="hidden" name="category" value={category.slug} />
                <input type="hidden" name="ref" value={pending.ref} />
                <input type="hidden" name="title" value={pending.title} />
                <input
                  type="hidden"
                  name="tracks_count"
                  value={pending.tracks}
                />
                <select name="decade" aria-label="Decade">
                  <option value="">no decade</option>
                  {decadeChoices.map((d) => (
                    <option value={d}>{eraLabel(Number(d))}</option>
                  ))}
                </select>
                <PillButton variant="primary" small>
                  Add this playlist
                </PillButton>
              </form>
            </div>
          </div>
        )}
        <form method="post" action="/admin/sources/lookup" class="group-row">
          <input type="hidden" name="category" value={category.slug} />
          <span class="row-text">
            <b>
              <label for="url">Add a source</label>
            </b>
            <small>Paste a Deezer playlist URL or id.</small>
          </span>
          <span class="row-side">
            <input
              id="url"
              name="url"
              type="text"
              required
              spellcheck={false}
              autocomplete="off"
            />
            <PillButton variant="outline" small>
              Look up
            </PillButton>
          </span>
        </form>
      </Group>
    </>,
  );
}

interface TrackRow {
  track_key: string;
  title: string;
  original_title: string | null;
  preview: string | null;
  artist: string;
  year: number | null;
  answer_title: string | null;
  ban_reason: string | null;
  answer_year: number | null;
  banned_at: number | null;
  plays: number;
  correct_rate: number | null;
  open_reports: number;
}

function tracksPage(
  user: SignedInUser,
  category: AdminCategory,
  tracks: TrackRow[],
  q: string,
  decade: string,
  open: number,
) {
  const filtered = q !== "" || decade !== "";
  return adminPage(
    user,
    "categories",
    open,
    `${category.name} tracks`,
    `Tracks served to ${category.name} games.`,
    <>
      <form method="get" class="toolbar" aria-label="Track filters">
        <label for="q">Search</label>
        <input
          id="q"
          name="q"
          type="search"
          value={q}
          placeholder="Title or artist"
        />
        <label for="decade">Decade</label>
        <select id="decade" name="decade">
          <option value="">All</option>
          {decadeChoices.map((d) => (
            <option value={d} selected={decade === d}>
              {eraLabel(Number(d))}
            </option>
          ))}
        </select>
        <PillButton variant="primary" small type="submit">
          Filter
        </PillButton>
        <small class="toolbar-count">
          {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
        </small>
      </form>
      <Group title="Tracks">
        {tracks.length === 0 ? (
          <div class="group-row">
            <p class="meta">
              {filtered ? (
                <>
                  No tracks match this filter.{" "}
                  <a href={`/admin/categories/${category.slug}/tracks`}>
                    Show all tracks
                  </a>
                </>
              ) : (
                <>
                  No tracks in this category yet.{" "}
                  <a href={`/admin/categories/${category.slug}`}>
                    Refresh its sources
                  </a>
                </>
              )}
            </p>
          </div>
        ) : (
          tracks.map((track) => (
            <details class="track-row" key={track.track_key}>
              <summary>
                <span class="row-text">
                  <b>{track.answer_title ?? track.title}</b>
                  <small>
                    {track.original_title !== null &&
                      `${track.original_title} · `}
                    {track.artist}
                    {track.year !== null && ` · ${track.year}`}
                    {` · ${track.plays} plays`}
                    {track.correct_rate !== null &&
                      ` · ${Math.round(track.correct_rate * 100)}% correct`}
                    {track.banned_at !== null &&
                      ` · banned${track.ban_reason ? ` (${track.ban_reason})` : ""}`}
                  </small>
                </span>
                <span class="badges">
                  {track.preview !== null && <span class="badge">iTunes</span>}
                  {track.banned_at !== null && (
                    <span class="badge danger">banned</span>
                  )}
                  {track.open_reports > 0 && (
                    <span class="badge danger">{track.open_reports} open</span>
                  )}
                </span>
              </summary>
              <div class="row-forms">
                <form method="post" action="/admin/tracks/save">
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="track_key"
                    value={track.track_key}
                  />
                  <span class="form-row">
                    <label for={`at-${track.track_key}`}>Answer title</label>
                    <input
                      id={`at-${track.track_key}`}
                      name="answer_title"
                      type="text"
                      value={track.answer_title ?? ""}
                    />
                  </span>
                  <span class="form-row">
                    <label for={`ay-${track.track_key}`}>Answer year</label>
                    <input
                      id={`ay-${track.track_key}`}
                      name="answer_year"
                      type="number"
                      value={track.answer_year ?? ""}
                    />
                  </span>
                  <PillButton variant="primary" small type="submit">
                    Save
                  </PillButton>
                </form>
                <form
                  method="post"
                  action="/admin/tracks/ban"
                  onsubmit={
                    track.banned_at === null
                      ? "return confirm('Ban this track?')"
                      : undefined
                  }
                >
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="track_key"
                    value={track.track_key}
                  />
                  <input
                    type="hidden"
                    name="ban"
                    value={track.banned_at === null ? "1" : "0"}
                  />
                  {track.banned_at === null && (
                    <span class="form-row">
                      <label for={`rs-${track.track_key}`}>Ban reason</label>
                      <input
                        id={`rs-${track.track_key}`}
                        name="reason"
                        type="text"
                        value={track.ban_reason ?? ""}
                      />
                    </span>
                  )}
                  <PillButton
                    variant={track.banned_at === null ? "danger" : "ghost"}
                    small
                  >
                    {track.banned_at === null ? "Ban" : "Unban"}
                  </PillButton>
                </form>
              </div>
            </details>
          ))
        )}
      </Group>
    </>,
  );
}

interface ReportRow {
  id: number;
  track_key: string;
  title: string;
  artist: string;
  category: string | null;
  reason: string;
  detail: string | null;
  created_at: number;
}

function reportsPage(user: SignedInUser, reports: ReportRow[]) {
  return adminPage(
    user,
    "reports",
    reports.length,
    "Reports",
    "Reports players file from games.",
    <Group title="Open reports" aside={`${reports.length}`}>
      {reports.length === 0 ? (
        <div class="group-row">
          <p class="meta">
            No open reports. Reports a player files during a game land here.
          </p>
        </div>
      ) : (
        reports.map((report) => (
          <div class="group-row" key={report.id}>
            <span class="row-text">
              <b>
                {report.title} — {report.artist}
              </b>
              <small>
                {report.reason.replaceAll("_", " ")}
                {report.detail && ` · ${report.detail}`}
                {report.category && ` · ${report.category}`}
                {` · ${new Date(report.created_at * 1000)
                  .toISOString()
                  .slice(0, 10)}`}
                {report.category && (
                  <>
                    {" · "}
                    <a
                      href={`/admin/categories/${report.category}/tracks?q=${encodeURIComponent(report.title)}`}
                    >
                      track
                    </a>
                  </>
                )}
              </small>
            </span>
            <form
              class="row-side"
              method="post"
              action="/admin/reports/resolve"
            >
              <input type="hidden" name="id" value={report.id} />
              <label for={`res-${report.id}`}>Resolution</label>
              <input id={`res-${report.id}`} name="resolution" type="text" />
              <PillButton variant="primary" small type="submit">
                Resolve
              </PillButton>
            </form>
          </div>
        ))
      )}
    </Group>,
  );
}

interface UserRow {
  id: number;
  name: string;
  github_id: number;
  is_public: number;
  admin_hidden: number;
}

function usersPage(
  user: SignedInUser,
  users: UserRow[],
  q: string,
  open: number,
) {
  return adminPage(
    user,
    "users",
    open,
    "Users",
    "Players and their visibility.",
    <>
      <form method="get" class="toolbar" aria-label="User search">
        <label for="q">Name</label>
        <input
          id="q"
          name="q"
          type="search"
          value={q}
          placeholder="User name"
        />
        <PillButton variant="primary" small type="submit">
          Search
        </PillButton>
        <small class="toolbar-count">
          {users.length} {users.length === 1 ? "user" : "users"}
        </small>
      </form>
      <Group title="Users">
        {users.length === 0 ? (
          <div class="group-row">
            <p class="meta">
              {q !== "" ? (
                <>
                  No users match “{q}”. <a href="/admin/users">Show everyone</a>
                </>
              ) : (
                "No users yet."
              )}
            </p>
          </div>
        ) : (
          users.map((row) => (
            <div class="group-row" key={row.id}>
              <span class="row-text">
                <b>{row.name}</b>
                <small>
                  {hasGithub(row) ? `GitHub ${row.github_id}` : "Google only"}
                </small>
              </span>
              <span class="badges">
                {row.is_public === 0 && (
                  <span class="badge accent">profile hidden</span>
                )}
                {row.admin_hidden === 1 && (
                  <span class="badge danger">hidden</span>
                )}
              </span>
              <form
                method="post"
                action="/admin/users/hide"
                onsubmit={
                  row.admin_hidden === 1
                    ? undefined
                    : "return confirm('Hide this user?')"
                }
              >
                <input type="hidden" name="user_id" value={row.id} />
                <input
                  type="hidden"
                  name="hidden"
                  value={row.admin_hidden === 1 ? "0" : "1"}
                />
                <PillButton
                  variant={row.admin_hidden === 1 ? "ghost" : "danger"}
                  small
                >
                  {row.admin_hidden === 1 ? "Show" : "Hide"}
                </PillButton>
              </form>
            </div>
          ))
        )}
      </Group>
    </>,
  );
}

export const adminApp = new Hono<{
  Bindings: Env;
  Variables: { admin: SignedInUser };
}>();

adminApp.use("*", async (context, next) => {
  const user = await sessionUser(context);
  if (user === null || !adminIds(context.env).has(user.github_id))
    return context.html(notFoundPage(user), 404);
  context.set("admin", user);
  await next();
});

adminApp.use("*", csrf());

adminApp.get("/", async (context) => {
  const [categories, open] = await Promise.all([
    context.env.DB.prepare(
      `SELECT c.slug, c.name, c.feed, c.ref, c.position, c.hidden,
              (SELECT COUNT(DISTINCT cm.track_key)
               FROM category_sources cs
               JOIN catalog_members cm ON cm.source_id = cs.id
               WHERE cs.category = c.slug) AS tracks
       FROM categories c ORDER BY c.position, c.slug`,
    ).all<AdminCategory>(),
    openReports(context.env.DB),
  ]);
  return context.html(
    indexPage(context.get("admin"), categories.results, open),
  );
});

adminApp.post("/categories", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "slug");
  const name = await field(context, "name");
  if (!/^[a-z0-9-]+$/.test(slug) || name === "")
    return context.text(
      "A slug is lowercase letters, digits and hyphens.",
      400,
    );
  const next = await context.env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) + 10 AS p FROM categories",
  ).first<{ p: number }>();
  try {
    await context.env.DB.prepare(
      "INSERT INTO categories (slug, name, feed, ref, position) VALUES (?1, ?2, 'deezer_playlist', NULL, ?3)",
    )
      .bind(slug, name, next?.p ?? 10)
      .run();
  } catch {
    return context.text("That slug is taken.", 400);
  }
  await logAction(context.env.DB, admin, "category.create", slug, name);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.post("/categories/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "slug");
  const name = await field(context, "name");
  const position = Number(await field(context, "position"));
  const hidden = (await context.req.parseBody()).hidden === "on" ? 1 : 0;
  if (name === "" || !Number.isInteger(position))
    return context.text("Name and order are required.", 400);
  await context.env.DB.prepare(
    "UPDATE categories SET name = ?1, position = ?2, hidden = ?3 WHERE slug = ?4",
  )
    .bind(name, position, hidden, slug)
    .run();
  await context.env.CACHE?.delete(`play:cat:${slug}`).catch(() => undefined);
  await logAction(
    context.env.DB,
    admin,
    "category.save",
    slug,
    `name=${name} position=${position} hidden=${hidden}`,
  );
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.get("/categories/:slug", async (context) => {
  const slug = context.req.param("slug");
  const category = await findCategory(context.env.DB, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const sources = await context.env.DB.prepare(
    "SELECT * FROM category_sources WHERE category = ?1 ORDER BY position, id",
  )
    .bind(slug)
    .all<CategorySource>();
  const open = await openReports(context.env.DB);
  return context.html(
    categoryPage(context.get("admin"), category, sources.results, null, open),
  );
});

adminApp.post("/sources/lookup", async (context) => {
  const slug = await field(context, "category");
  const category = await findCategory(context.env.DB, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const url = await field(context, "url");
  const trimmed = url.trim();
  let id: string | undefined;
  if (/^\d+$/.test(trimmed)) {
    id = trimmed;
  } else {
    const segments = URL.parse(trimmed)?.pathname.split("/") ?? [];
    const at = segments.indexOf("playlist");
    if (at !== -1 && /^\d+$/.test(segments[at + 1] ?? ""))
      id = segments[at + 1];
  }
  const [sources, open] = await Promise.all([
    context.env.DB.prepare(
      "SELECT * FROM category_sources WHERE category = ?1 ORDER BY position, id",
    )
      .bind(slug)
      .all<CategorySource>(),
    openReports(context.env.DB),
  ]);
  if (id === undefined)
    return context.html(
      categoryPage(context.get("admin"), category, sources.results, null, open),
      400,
    );
  const info = await deezerPlaylistInfo(id).catch(() => null);
  if (info === null) return context.text("Playlist not found.", 404);
  return context.html(
    categoryPage(
      context.get("admin"),
      category,
      sources.results,
      {
        ref: id,
        title: info.title,
        owner: info.owner,
        tracks: info.tracks,
      },
      open,
    ),
  );
});

adminApp.post("/sources", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const ref = await field(context, "ref");
  const title = await field(context, "title");
  const tracksCount = Number(await field(context, "tracks_count"));
  const decadeRaw = await field(context, "decade");
  const decade = /^\d{4}$/.test(decadeRaw) ? Number(decadeRaw) : null;
  if (!/^\d{4,}$/.test(ref)) return context.text("Bad playlist id.", 400);
  const next = await context.env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM category_sources WHERE category = ?1",
  )
    .bind(slug)
    .first<{ p: number }>();
  try {
    await context.env.DB.prepare(
      `INSERT INTO category_sources
         (category, kind, ref, title, tracks_count, decade, position)
       VALUES (?1, 'deezer_playlist', ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        slug,
        ref,
        title || null,
        Number.isInteger(tracksCount) ? tracksCount : null,
        decade,
        next?.p ?? 0,
      )
      .run();
  } catch {
    return context.text("That source is already listed.", 400);
  }
  await logAction(context.env.DB, admin, "source.add", slug, ref);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.post("/sources/remove", async (context) => {
  const admin = context.get("admin");
  const id = Number(await field(context, "id"));
  const slug = await field(context, "category");
  await context.env.DB.prepare("DELETE FROM category_sources WHERE id = ?1")
    .bind(id)
    .run();
  await context.env.CACHE?.delete(`play:cat:${slug}`).catch(() => undefined);
  await logAction(context.env.DB, admin, "source.remove", slug, String(id));
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.post("/refresh", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "slug");
  try {
    await refreshCategorySources(context.env, slug);
    await fillMissingYears(context.env);
  } catch {
    return context.text(
      "Refresh failed; the feed will retry on the cron.",
      502,
    );
  }
  await logAction(context.env.DB, admin, "source.refresh", slug);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.get("/categories/:slug/tracks", async (context) => {
  const slug = context.req.param("slug");
  const category = await findCategory(context.env.DB, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const q = context.req.query("q") ?? "";
  const decade = context.req.query("decade") ?? "";
  const clauses = ["cs.category = ?1"];
  const params: (string | number)[] = [slug];
  if (q !== "") {
    clauses.push("(ct.title LIKE ?2 OR ct.artist LIKE ?2)");
    params.push(`%${q}%`);
  }
  let having = "";
  if (/^\d{4}$/.test(decade)) {
    params.push(Number(decade));
    having = `HAVING COALESCE(
       CASE WHEN ct.answer_year > 0 THEN ct.answer_year / 10 * 10 END,
       MIN(cs.decade),
       CASE WHEN ct.year > 0 THEN ct.year / 10 * 10 END
     ) = ?${params.length}`;
  }
  const rows = await context.env.DB.prepare(
    `SELECT ct.track_key, ct.title, ct.original_title, ct.preview, ct.artist,
            ct.year, ct.answer_title, ct.answer_year, ct.banned_at,
            ct.ban_reason,
            (SELECT COUNT(*) FROM round_outcomes ro
              WHERE ro.track_key = ct.track_key
                AND ro.category = ?1) AS plays,
            (SELECT AVG(ro.correct) FROM round_outcomes ro
              WHERE ro.track_key = ct.track_key
                AND ro.category = ?1) AS correct_rate,
            (SELECT COUNT(*) FROM track_reports tr
              WHERE tr.track_key = ct.track_key
                AND tr.resolved_at IS NULL) AS open_reports
     FROM category_sources cs
     JOIN catalog_members cm ON cm.source_id = cs.id
     JOIN catalog_tracks ct ON ct.track_key = cm.track_key
     WHERE ${clauses.join(" AND ")}
     GROUP BY ct.track_key
     ${having}
     ORDER BY ct.title
     LIMIT 300`,
  )
    .bind(...params)
    .all<TrackRow>();
  const open = await openReports(context.env.DB);
  return context.html(
    tracksPage(context.get("admin"), category, rows.results, q, decade, open),
  );
});

adminApp.post("/tracks/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const answerTitle = await field(context, "answer_title");
  const answerYear = Number(await field(context, "answer_year"));
  await context.env.DB.prepare(
    `UPDATE catalog_tracks
     SET answer_title = ?1, answer_year = ?2 WHERE track_key = ?3`,
  )
    .bind(
      answerTitle || null,
      Number.isInteger(answerYear) && answerYear > 0 ? answerYear : null,
      trackKey,
    )
    .run();
  await dropTrackCaches(context.env, trackKey);
  await logAction(context.env.DB, admin, "track.save", trackKey, slug);
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.post("/tracks/ban", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const ban = (await field(context, "ban")) === "1";
  const reason = await field(context, "reason");
  await context.env.DB.prepare(
    "UPDATE catalog_tracks SET banned_at = ?1, ban_reason = ?2 WHERE track_key = ?3",
  )
    .bind(
      ban ? Math.floor(Date.now() / 1000) : null,
      ban ? reason || null : null,
      trackKey,
    )
    .run();
  await dropTrackCaches(context.env, trackKey);
  await logAction(
    context.env.DB,
    admin,
    ban ? "track.ban" : "track.unban",
    trackKey,
    slug,
  );
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.get("/reports", async (context) => {
  const reports = await context.env.DB.prepare(
    `SELECT id, track_key, title, artist, category, reason,
            detail, created_at
     FROM track_reports WHERE resolved_at IS NULL ORDER BY created_at DESC`,
  ).all<ReportRow>();
  return context.html(reportsPage(context.get("admin"), reports.results));
});

adminApp.post("/reports/resolve", async (context) => {
  const admin = context.get("admin");
  const id = Number(await field(context, "id"));
  const resolution = await field(context, "resolution");
  await context.env.DB.prepare(
    `UPDATE track_reports
     SET resolved_at = ?1, resolved_by = ?2, resolution = ?3
     WHERE id = ?4 AND resolved_at IS NULL`,
  )
    .bind(
      Math.floor(Date.now() / 1000),
      admin.github_id,
      resolution || null,
      id,
    )
    .run();
  await logAction(
    context.env.DB,
    admin,
    "report.resolve",
    String(id),
    resolution,
  );
  return context.redirect("/admin/reports", 303);
});

adminApp.get("/users", async (context) => {
  const q = context.req.query("q") ?? "";
  const rows = await context.env.DB.prepare(
    `SELECT id, name, github_id, is_public, admin_hidden
     FROM users
     WHERE ?1 = '' OR name LIKE ?2
     ORDER BY name LIMIT 100`,
  )
    .bind(q, `%${q}%`)
    .all<UserRow>();
  const open = await openReports(context.env.DB);
  return context.html(usersPage(context.get("admin"), rows.results, q, open));
});

adminApp.post("/users/hide", async (context) => {
  const admin = context.get("admin");
  const userId = Number(await field(context, "user_id"));
  const hidden = (await field(context, "hidden")) === "1" ? 1 : 0;
  await context.env.DB.prepare(
    "UPDATE users SET admin_hidden = ?1 WHERE id = ?2",
  )
    .bind(hidden, userId)
    .run();
  const boards = ["play:board:week", "play:board:all"];
  const cats = await context.env.DB.prepare(
    "SELECT DISTINCT category FROM game_results WHERE user_id = ?1",
  )
    .bind(userId)
    .all<{ category: string }>();
  boards.push(...cats.results.map((c) => `play:catboard:${c.category}`));
  for (const key of boards)
    await context.env.CACHE?.delete(key).catch(() => undefined);
  await logAction(
    context.env.DB,
    admin,
    hidden === 1 ? "user.hide" : "user.show",
    String(userId),
  );
  return context.redirect("/admin/users", 303);
});
