import { Hono, type Context } from "hono";
import { csrf } from "hono/csrf";
import { notFoundPage } from "./app";
import { sessionUser, type SignedInUser } from "./auth";
import {
  dropTrackCaches,
  fillMissingYears,
  refreshCategorySources,
  type CategorySource,
} from "./play/refresh";
import { deezerPlaylistInfo } from "./play/sources";
import type { Env } from "./types";
import { PillButton } from "./ui/pill";
import { Section } from "./ui/section";
import { Page } from "./ui/shell";

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

function eraLabel(decade: number) {
  return `${String(decade).slice(2)}s`;
}
const decadeChoices = ["1960", "1970", "1980", "1990", "2000", "2010", "2020"];

function adminNav() {
  return (
    <p class="meta">
      <a href="/admin">Categories</a> · <a href="/admin/reports">Reports</a> ·{" "}
      <a href="/admin/users">Users</a>
    </p>
  );
}

function indexPage(user: SignedInUser, categories: AdminCategory[]) {
  return Page({
    title: "Admin",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Admin</h1>
          {adminNav()}
        </div>
        <Section title="Categories">
          <ul class="rows">
            {categories.map((category) => (
              <li key={category.slug}>
                <span class="track">
                  <b>
                    <a href={`/admin/categories/${category.slug}`}>
                      {category.name}
                    </a>
                  </b>
                  <small>
                    {category.slug} · order {category.position} ·{" "}
                    {category.feed}
                    {category.hidden === 1 ? " · hidden" : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
          <form method="post" action="/admin/categories" class="stack">
            <div class="field">
              <label for="slug">Slug</label>
              <input
                id="slug"
                name="slug"
                type="text"
                required
                spellcheck={false}
                autocomplete="off"
              />
            </div>
            <div class="field">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" required />
            </div>
            <div>
              <PillButton variant="primary">Create category</PillButton>
            </div>
          </form>
        </Section>
      </>
    ),
  });
}

function categoryPage(
  user: SignedInUser,
  category: AdminCategory,
  sources: CategorySource[],
  pending: { ref: string; title: string; owner: string; tracks: number } | null,
) {
  return Page({
    title: `${category.name} · Admin`,
    user,
    children: (
      <>
        <div class="page-head">
          <h1>{category.name}</h1>
          {adminNav()}
        </div>
        <Section title="Category">
          <form method="post" action="/admin/categories/save" class="stack">
            <input type="hidden" name="slug" value={category.slug} />
            <div class="field">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" value={category.name} />
            </div>
            <div class="field">
              <label for="position">Order</label>
              <input
                id="position"
                name="position"
                type="number"
                value={category.position}
              />
            </div>
            <div>
              <label class="check" for="hidden">
                <input
                  id="hidden"
                  name="hidden"
                  type="checkbox"
                  checked={category.hidden === 1}
                />
                <span>Hidden</span>
              </label>
              <small class="hint">
                A hidden category leaves /play and its games return the
                unavailable page.
              </small>
            </div>
            <div>
              <PillButton variant="primary">Save</PillButton>
            </div>
          </form>
          <form method="post" action="/admin/refresh">
            <input type="hidden" name="slug" value={category.slug} />
            <PillButton small>Refresh sources now</PillButton>
          </form>
          <p>
            <a href={`/admin/categories/${category.slug}/tracks`}>
              Category tracks
            </a>
          </p>
        </Section>
        <Section title="Sources">
          {sources.length === 0 ? (
            <p class="muted">No sources.</p>
          ) : (
            <ul class="rows">
              {sources.map((source) => (
                <li key={source.id}>
                  <span class="track">
                    <b>{source.title ?? `playlist ${source.ref}`}</b>
                    <small>
                      {source.kind} · {source.ref}
                      {source.decade !== null &&
                        ` · ${eraLabel(source.decade)}`}
                      {source.tracks_count !== null &&
                        ` · ${source.tracks_count} tracks`}
                      {source.refreshed_at !== null &&
                        ` · refreshed ${new Date(source.refreshed_at * 1000)
                          .toISOString()
                          .slice(0, 10)}`}
                    </small>
                  </span>
                  <form method="post" action="/admin/sources/remove">
                    <input type="hidden" name="id" value={source.id} />
                    <input
                      type="hidden"
                      name="category"
                      value={category.slug}
                    />
                    <PillButton small>Remove</PillButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {pending !== null && (
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
          )}
          <form method="post" action="/admin/sources/lookup" class="stack">
            <input type="hidden" name="category" value={category.slug} />
            <div class="field">
              <label for="url">Deezer playlist URL or id</label>
              <input
                id="url"
                name="url"
                type="text"
                required
                spellcheck={false}
                autocomplete="off"
              />
            </div>
            <div>
              <PillButton small>Look up playlist</PillButton>
            </div>
          </form>
        </Section>
      </>
    ),
  });
}

interface TrackRow {
  deezer_id: number;
  title: string;
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
) {
  const decades = decadeChoices;
  return Page({
    title: `${category.name} tracks · Admin`,
    user,
    children: (
      <>
        <div class="page-head">
          <h1>{category.name} tracks</h1>
          {adminNav()}
        </div>
        <Section title="Filter">
          <form method="get" class="stack">
            <div class="field">
              <label for="q">Search title or artist</label>
              <input id="q" name="q" type="text" value={q} />
            </div>
            <div class="field">
              <label for="decade">Decade</label>
              <select id="decade" name="decade">
                <option value="">All</option>
                {decades.map((d) => (
                  <option value={d} selected={decade === d}>
                    {eraLabel(Number(d))}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <PillButton small type="submit">
                Filter
              </PillButton>
            </div>
          </form>
        </Section>
        <Section title={`Tracks (${tracks.length})`}>
          <ul class="rows">
            {tracks.map((track) => (
              <li key={track.deezer_id}>
                <span class="track">
                  <b>
                    {track.answer_title ?? track.title}
                    {track.banned_at !== null &&
                      ` · banned${track.ban_reason ? ` (${track.ban_reason})` : ""}`}
                  </b>
                  <small>
                    {track.artist}
                    {track.year !== null && ` · ${track.year}`}
                    {` · ${track.plays} plays`}
                    {track.correct_rate !== null &&
                      ` · ${Math.round(track.correct_rate * 100)}% correct`}
                    {track.open_reports > 0 &&
                      ` · ${track.open_reports} open reports`}
                  </small>
                </span>
                <form
                  method="post"
                  action="/admin/tracks/save"
                  class="track-edit"
                >
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="deezer_id"
                    value={track.deezer_id}
                  />
                  <input
                    name="answer_title"
                    type="text"
                    placeholder="answer title"
                    value={track.answer_title ?? ""}
                  />
                  <input
                    name="answer_year"
                    type="number"
                    placeholder="year"
                    value={track.answer_year ?? ""}
                  />
                  <PillButton small type="submit">
                    Save
                  </PillButton>
                </form>
                <form method="post" action="/admin/tracks/ban">
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="deezer_id"
                    value={track.deezer_id}
                  />
                  <input
                    type="hidden"
                    name="ban"
                    value={track.banned_at === null ? "1" : "0"}
                  />
                  {track.banned_at === null && (
                    <input
                      name="reason"
                      type="text"
                      placeholder="reason"
                      value={track.ban_reason ?? ""}
                    />
                  )}
                  <PillButton small>
                    {track.banned_at === null ? "Ban" : "Unban"}
                  </PillButton>
                </form>
              </li>
            ))}
          </ul>
        </Section>
      </>
    ),
  });
}

interface ReportRow {
  id: number;
  track_key: string;
  deezer_id: number | null;
  title: string;
  artist: string;
  category: string | null;
  reason: string;
  detail: string | null;
  created_at: number;
}

function reportsPage(user: SignedInUser, reports: ReportRow[]) {
  return Page({
    title: "Reports · Admin",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Reports</h1>
          {adminNav()}
        </div>
        <Section title={`Open reports (${reports.length})`}>
          {reports.length === 0 ? (
            <p class="muted">No open reports.</p>
          ) : (
            <ul class="rows">
              {reports.map((report) => (
                <li key={report.id}>
                  <span class="track">
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
                  <form method="post" action="/admin/reports/resolve">
                    <input type="hidden" name="id" value={report.id} />
                    <input
                      name="resolution"
                      type="text"
                      placeholder="resolution"
                    />
                    <PillButton small type="submit">
                      Resolve
                    </PillButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </>
    ),
  });
}

interface UserRow {
  id: number;
  name: string;
  github_id: number;
  is_public: number;
  admin_hidden: number;
}

function usersPage(user: SignedInUser, users: UserRow[], q: string) {
  return Page({
    title: "Users · Admin",
    user,
    children: (
      <>
        <div class="page-head">
          <h1>Users</h1>
          {adminNav()}
        </div>
        <Section title="Search">
          <form method="get" class="stack">
            <div class="field">
              <label for="q">Name</label>
              <input id="q" name="q" type="text" value={q} />
            </div>
            <div>
              <PillButton small type="submit">
                Search
              </PillButton>
            </div>
          </form>
        </Section>
        <Section title={`Users (${users.length})`}>
          {users.length === 0 ? (
            <p class="muted">No users found.</p>
          ) : (
            <ul class="rows">
              {users.map((row) => (
                <li key={row.id}>
                  <span class="track">
                    <b>{row.name}</b>
                    <small>
                      GitHub {row.github_id}
                      {row.is_public === 0 && " · profile hidden"}
                      {row.admin_hidden === 1 && " · hidden by admin"}
                    </small>
                  </span>
                  <form method="post" action="/admin/users/hide">
                    <input type="hidden" name="user_id" value={row.id} />
                    <input
                      type="hidden"
                      name="hidden"
                      value={row.admin_hidden === 1 ? "0" : "1"}
                    />
                    <PillButton small>
                      {row.admin_hidden === 1 ? "Show" : "Hide"}
                    </PillButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </>
    ),
  });
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
  const categories = await context.env.DB.prepare(
    "SELECT slug, name, feed, ref, position, hidden FROM categories ORDER BY position, slug",
  ).all<AdminCategory>();
  return context.html(indexPage(context.get("admin"), categories.results));
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
  return context.html(
    categoryPage(context.get("admin"), category, sources.results, null),
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
  const sources = await context.env.DB.prepare(
    "SELECT * FROM category_sources WHERE category = ?1 ORDER BY position, id",
  )
    .bind(slug)
    .all<CategorySource>();
  if (id === undefined)
    return context.html(
      categoryPage(context.get("admin"), category, sources.results, null),
      400,
    );
  const info = await deezerPlaylistInfo(id).catch(() => null);
  if (info === null) return context.text("Playlist not found.", 404);
  return context.html(
    categoryPage(context.get("admin"), category, sources.results, {
      ref: id,
      title: info.title,
      owner: info.owner,
      tracks: info.tracks,
    }),
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
    `SELECT ct.deezer_id, ct.title, ct.artist, ct.year,
            ct.answer_title, ct.answer_year, ct.banned_at, ct.ban_reason,
            (SELECT COUNT(*) FROM round_outcomes ro
              WHERE ro.deezer_id = ct.deezer_id
                AND ro.category = ?1) AS plays,
            (SELECT AVG(ro.correct) FROM round_outcomes ro
              WHERE ro.deezer_id = ct.deezer_id
                AND ro.category = ?1) AS correct_rate,
            (SELECT COUNT(*) FROM track_reports tr
              WHERE tr.deezer_id = ct.deezer_id
                AND tr.resolved_at IS NULL) AS open_reports
     FROM category_sources cs
     JOIN catalog_members cm ON cm.source_id = cs.id
     JOIN catalog_tracks ct ON ct.deezer_id = cm.deezer_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY ct.deezer_id
     ${having}
     ORDER BY ct.title
     LIMIT 300`,
  )
    .bind(...params)
    .all<TrackRow>();
  return context.html(
    tracksPage(context.get("admin"), category, rows.results, q, decade),
  );
});

adminApp.post("/tracks/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const deezerId = Number(await field(context, "deezer_id"));
  const answerTitle = await field(context, "answer_title");
  const answerYear = Number(await field(context, "answer_year"));
  await context.env.DB.prepare(
    `UPDATE catalog_tracks
     SET answer_title = ?1, answer_year = ?2 WHERE deezer_id = ?3`,
  )
    .bind(
      answerTitle || null,
      Number.isInteger(answerYear) && answerYear > 0 ? answerYear : null,
      deezerId,
    )
    .run();
  await dropTrackCaches(context.env, deezerId);
  await logAction(context.env.DB, admin, "track.save", String(deezerId), slug);
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.post("/tracks/ban", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const deezerId = Number(await field(context, "deezer_id"));
  const ban = (await field(context, "ban")) === "1";
  const reason = await field(context, "reason");
  await context.env.DB.prepare(
    "UPDATE catalog_tracks SET banned_at = ?1, ban_reason = ?2 WHERE deezer_id = ?3",
  )
    .bind(
      ban ? Math.floor(Date.now() / 1000) : null,
      ban ? reason || null : null,
      deezerId,
    )
    .run();
  await dropTrackCaches(context.env, deezerId);
  await logAction(
    context.env.DB,
    admin,
    ban ? "track.ban" : "track.unban",
    String(deezerId),
    slug,
  );
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.get("/reports", async (context) => {
  const reports = await context.env.DB.prepare(
    `SELECT id, track_key, deezer_id, title, artist, category, reason,
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
  return context.html(usersPage(context.get("admin"), rows.results, q));
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
