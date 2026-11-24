import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { csrf } from "hono/csrf";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  isNull,
  like,
  max,
  or,
  sql,
} from "drizzle-orm";
import { hasGithub, sessionUser, type SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import {
  dropTrackCaches,
  fillMissingYears,
  refreshCategorySources,
  type CategorySource,
} from "../play/catalog/refresh";
import { hubTilesKey } from "../play/hub/hub";
import { deezerPlaylistInfo } from "../play/catalog/sources";
import type { Env } from "../env";
import { notFoundPage } from "../ui/not-found";
import { PillButton } from "../ui/pill";
import { Page } from "../ui/shell";
import { eraLabel, generations } from "../play/catalog/eras";

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

type AdminCategory = typeof t.categories.$inferSelect & { tracks?: number };

async function logAction(
  env: Env,
  admin: SignedInUser,
  action: string,
  target: string,
  detail = "",
) {
  await database(env.DB)
    .insert(t.adminActions)
    .values({
      githubId: admin.githubId,
      action,
      target,
      detail,
      createdAt: Math.floor(Date.now() / 1000),
    });
}

async function findCategory(env: Env, slug: string) {
  const category = await database(env.DB)
    .select()
    .from(t.categories)
    .where(eq(t.categories.slug, slug))
    .get();
  return category ?? null;
}

function categorySources(env: Env, slug: string) {
  return database(env.DB)
    .select()
    .from(t.categorySources)
    .where(eq(t.categorySources.category, slug))
    .orderBy(t.categorySources.position, t.categorySources.id);
}

async function field(context: AdminContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

const decadeChoices = [
  "1960",
  "1970",
  "1980",
  "1990",
  "2000",
  "2010",
  "2020",
  ...Object.keys(generations),
].sort();

type AdminSection = "categories" | "reports" | "users";

function kindLabel(kind: string) {
  return kind.replaceAll("_", " ");
}

function openReports(env: Env) {
  return database(env.DB).$count(
    t.trackReports,
    isNull(t.trackReports.resolvedAt),
  );
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
    styles: ["common", "site", "admin"],
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
                {source.tracksCount !== null &&
                  ` · ${source.tracksCount} tracks`}
                {source.refreshedAt !== null &&
                  ` · refreshed ${new Date(source.refreshedAt * 1000)
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
              data-confirm="Remove this source?"
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

// The decade a track counts under: its answer year, else the decade its
// playlist is filed under, else its release year.
const trackDecade = sql<number | null>`COALESCE(
  CASE WHEN ${t.catalogTracks.answerYear} > 0
    THEN ${t.catalogTracks.answerYear} / 10 * 10 END,
  MIN(${t.categorySources.decade}),
  CASE WHEN ${t.catalogTracks.year} > 0
    THEN ${t.catalogTracks.year} / 10 * 10 END
)`;

function categoryTracks(env: Env, slug: string, q: string, decade: string) {
  const db = database(env.DB);
  const ct = t.catalogTracks;
  const ro = t.roundOutcomes;
  const outcomes = and(eq(ro.trackKey, ct.trackKey), eq(ro.category, slug));
  const plays = db.select({ n: count() }).from(ro).where(outcomes);
  const correctRate = db
    .select({ rate: sql`AVG(${ro.correct})` })
    .from(ro)
    .where(outcomes);
  const openReports = db
    .select({ n: count() })
    .from(t.trackReports)
    .where(
      and(
        eq(t.trackReports.trackKey, ct.trackKey),
        isNull(t.trackReports.resolvedAt),
      ),
    );
  const pattern = `%${q}%`;
  return db
    .select({
      trackKey: ct.trackKey,
      title: ct.title,
      originalTitle: ct.originalTitle,
      preview: ct.preview,
      artist: ct.artist,
      year: ct.year,
      answerTitle: ct.answerTitle,
      answerYear: ct.answerYear,
      bannedAt: ct.bannedAt,
      banReason: ct.banReason,
      plays: sql<number>`(${plays})`,
      correctRate: sql<number | null>`(${correctRate})`,
      openReports: sql<number>`(${openReports})`,
    })
    .from(t.categorySources)
    .innerJoin(
      t.catalogMembers,
      eq(t.catalogMembers.sourceId, t.categorySources.id),
    )
    .innerJoin(ct, eq(ct.trackKey, t.catalogMembers.trackKey))
    .where(
      and(
        eq(t.categorySources.category, slug),
        q === ""
          ? undefined
          : or(like(ct.title, pattern), like(ct.artist, pattern)),
      ),
    )
    .groupBy(ct.trackKey)
    .having(
      /^\d{4}$/.test(decade)
        ? sql`${trackDecade} = ${Number(decade)}`
        : undefined,
    )
    .orderBy(ct.title)
    .limit(300);
}

type TrackRow = Awaited<ReturnType<typeof categoryTracks>>[number];

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
            <details class="track-row" key={track.trackKey}>
              <summary>
                <span class="row-text">
                  <b>{track.answerTitle ?? track.title}</b>
                  <small>
                    {track.originalTitle !== null &&
                      `${track.originalTitle} · `}
                    {track.artist}
                    {track.year !== null && ` · ${track.year}`}
                    {` · ${track.plays} plays`}
                    {track.correctRate !== null &&
                      ` · ${Math.round(track.correctRate * 100)}% correct`}
                    {track.bannedAt !== null &&
                      ` · banned${track.banReason ? ` (${track.banReason})` : ""}`}
                  </small>
                </span>
                <span class="badges">
                  {track.preview !== null && <span class="badge">iTunes</span>}
                  {track.bannedAt !== null && (
                    <span class="badge danger">banned</span>
                  )}
                  {track.openReports > 0 && (
                    <span class="badge danger">{track.openReports} open</span>
                  )}
                </span>
              </summary>
              <div class="row-forms">
                <form method="post" action="/admin/tracks/save">
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="track_key"
                    value={track.trackKey}
                  />
                  <span class="form-row">
                    <label for={`at-${track.trackKey}`}>Answer title</label>
                    <input
                      id={`at-${track.trackKey}`}
                      name="answer_title"
                      type="text"
                      value={track.answerTitle ?? ""}
                    />
                  </span>
                  <span class="form-row">
                    <label for={`ay-${track.trackKey}`}>Answer year</label>
                    <input
                      id={`ay-${track.trackKey}`}
                      name="answer_year"
                      type="number"
                      value={track.answerYear ?? ""}
                    />
                  </span>
                  <PillButton variant="primary" small type="submit">
                    Save
                  </PillButton>
                </form>
                <form
                  method="post"
                  action="/admin/tracks/ban"
                  data-confirm={
                    track.bannedAt === null ? "Ban this track?" : undefined
                  }
                >
                  <input type="hidden" name="category" value={category.slug} />
                  <input
                    type="hidden"
                    name="track_key"
                    value={track.trackKey}
                  />
                  <input
                    type="hidden"
                    name="ban"
                    value={track.bannedAt === null ? "1" : "0"}
                  />
                  {track.bannedAt === null && (
                    <span class="form-row">
                      <label for={`rs-${track.trackKey}`}>Ban reason</label>
                      <input
                        id={`rs-${track.trackKey}`}
                        name="reason"
                        type="text"
                        value={track.banReason ?? ""}
                      />
                    </span>
                  )}
                  <PillButton
                    variant={track.bannedAt === null ? "danger" : "ghost"}
                    small
                  >
                    {track.bannedAt === null ? "Ban" : "Unban"}
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

type ReportRow = typeof t.trackReports.$inferSelect;

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
                {` · ${new Date(report.createdAt * 1000)
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

type UserRow = Pick<
  typeof t.users.$inferSelect,
  "id" | "name" | "githubId" | "isPublic" | "adminHidden"
>;

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
                  {hasGithub(row) ? `GitHub ${row.githubId}` : "Google only"}
                </small>
              </span>
              <span class="badges">
                {row.isPublic === 0 && (
                  <span class="badge accent">profile hidden</span>
                )}
                {row.adminHidden === 1 && (
                  <span class="badge danger">hidden</span>
                )}
              </span>
              <form
                method="post"
                action="/admin/users/hide"
                data-confirm={
                  row.adminHidden === 1 ? undefined : "Hide this user?"
                }
              >
                <input type="hidden" name="user_id" value={row.id} />
                <input
                  type="hidden"
                  name="hidden"
                  value={row.adminHidden === 1 ? "0" : "1"}
                />
                <PillButton
                  variant={row.adminHidden === 1 ? "ghost" : "danger"}
                  small
                >
                  {row.adminHidden === 1 ? "Show" : "Hide"}
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
  if (user === null || !adminIds(context.env).has(user.githubId))
    return context.html(notFoundPage(user), 404);
  context.set("admin", user);
  await next();
});

adminApp.use("*", csrf());

adminApp.get("/", async (context) => {
  const db = database(context.env.DB);
  const tracks = db
    .select({ n: countDistinct(t.catalogMembers.trackKey) })
    .from(t.categorySources)
    .innerJoin(
      t.catalogMembers,
      eq(t.catalogMembers.sourceId, t.categorySources.id),
    )
    .where(eq(t.categorySources.category, t.categories.slug));
  const [categories, open] = await Promise.all([
    db
      .select({
        slug: t.categories.slug,
        name: t.categories.name,
        feed: t.categories.feed,
        ref: t.categories.ref,
        position: t.categories.position,
        hidden: t.categories.hidden,
        tracks: sql<number>`(${tracks})`,
      })
      .from(t.categories)
      .orderBy(t.categories.position, t.categories.slug),
    openReports(context.env),
  ]);
  return context.html(indexPage(context.get("admin"), categories, open));
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
  const db = database(context.env.DB);
  const last = await db
    .select({ position: max(t.categories.position) })
    .from(t.categories)
    .get();
  try {
    await db.insert(t.categories).values({
      slug,
      name,
      feed: "deezer_playlist",
      position: (last?.position ?? 0) + 10,
    });
  } catch {
    return context.text("That slug is taken.", 400);
  }
  await context.env.CACHE.delete(hubTilesKey).catch(() => undefined);
  await logAction(context.env, admin, "category.create", slug, name);
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
  await database(context.env.DB)
    .update(t.categories)
    .set({ name, position, hidden })
    .where(eq(t.categories.slug, slug));
  await Promise.all(
    [`play:cat:${slug}`, hubTilesKey].map((key) =>
      context.env.CACHE.delete(key).catch(() => undefined),
    ),
  );
  await logAction(
    context.env,
    admin,
    "category.save",
    slug,
    `name=${name} position=${position} hidden=${hidden}`,
  );
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.get("/categories/:slug", async (context) => {
  const slug = context.req.param("slug");
  const category = await findCategory(context.env, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const [sources, open] = await Promise.all([
    categorySources(context.env, slug),
    openReports(context.env),
  ]);
  return context.html(
    categoryPage(context.get("admin"), category, sources, null, open),
  );
});

adminApp.post("/sources/lookup", async (context) => {
  const slug = await field(context, "category");
  const category = await findCategory(context.env, slug);
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
    categorySources(context.env, slug),
    openReports(context.env),
  ]);
  if (id === undefined)
    return context.html(
      categoryPage(context.get("admin"), category, sources, null, open),
      400,
    );
  const info = await deezerPlaylistInfo(id).catch(() => null);
  if (info === null) return context.text("Playlist not found.", 404);
  return context.html(
    categoryPage(
      context.get("admin"),
      category,
      sources,
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
  const db = database(context.env.DB);
  const last = await db
    .select({ position: max(t.categorySources.position) })
    .from(t.categorySources)
    .where(eq(t.categorySources.category, slug))
    .get();
  try {
    await db.insert(t.categorySources).values({
      category: slug,
      kind: "deezer_playlist",
      ref,
      title: title || null,
      tracksCount: Number.isInteger(tracksCount) ? tracksCount : null,
      decade,
      position: (last?.position ?? -1) + 1,
    });
  } catch {
    return context.text("That source is already listed.", 400);
  }
  await logAction(context.env, admin, "source.add", slug, ref);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.post("/sources/remove", async (context) => {
  const admin = context.get("admin");
  const id = Number(await field(context, "id"));
  const slug = await field(context, "category");
  await database(context.env.DB)
    .delete(t.categorySources)
    .where(eq(t.categorySources.id, id));
  await context.env.CACHE.delete(`play:cat:${slug}`).catch(() => undefined);
  await logAction(context.env, admin, "source.remove", slug, String(id));
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
  await logAction(context.env, admin, "source.refresh", slug);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

adminApp.get("/categories/:slug/tracks", async (context) => {
  const slug = context.req.param("slug");
  const category = await findCategory(context.env, slug);
  if (category === null) return context.html(notFoundPage(), 404);
  const q = context.req.query("q") ?? "";
  const decade = context.req.query("decade") ?? "";
  const [rows, open] = await Promise.all([
    categoryTracks(context.env, slug, q, decade),
    openReports(context.env),
  ]);
  return context.html(
    tracksPage(context.get("admin"), category, rows, q, decade, open),
  );
});

adminApp.post("/tracks/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const answerTitle = await field(context, "answer_title");
  const answerYear = Number(await field(context, "answer_year"));
  await database(context.env.DB)
    .update(t.catalogTracks)
    .set({
      answerTitle: answerTitle || null,
      answerYear:
        Number.isInteger(answerYear) && answerYear > 0 ? answerYear : null,
    })
    .where(eq(t.catalogTracks.trackKey, trackKey));
  await dropTrackCaches(context.env, trackKey);
  await logAction(context.env, admin, "track.save", trackKey, slug);
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.post("/tracks/ban", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const ban = (await field(context, "ban")) === "1";
  const reason = await field(context, "reason");
  await database(context.env.DB)
    .update(t.catalogTracks)
    .set({
      bannedAt: ban ? Math.floor(Date.now() / 1000) : null,
      banReason: ban ? reason || null : null,
    })
    .where(eq(t.catalogTracks.trackKey, trackKey));
  await dropTrackCaches(context.env, trackKey);
  await logAction(
    context.env,
    admin,
    ban ? "track.ban" : "track.unban",
    trackKey,
    slug,
  );
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

adminApp.get("/reports", async (context) => {
  const reports = await database(context.env.DB)
    .select()
    .from(t.trackReports)
    .where(isNull(t.trackReports.resolvedAt))
    .orderBy(desc(t.trackReports.createdAt));
  return context.html(reportsPage(context.get("admin"), reports));
});

adminApp.post("/reports/resolve", async (context) => {
  const admin = context.get("admin");
  const id = Number(await field(context, "id"));
  const resolution = await field(context, "resolution");
  await database(context.env.DB)
    .update(t.trackReports)
    .set({
      resolvedAt: Math.floor(Date.now() / 1000),
      resolvedBy: admin.githubId,
      resolution: resolution || null,
    })
    .where(and(eq(t.trackReports.id, id), isNull(t.trackReports.resolvedAt)));
  await logAction(context.env, admin, "report.resolve", String(id), resolution);
  return context.redirect("/admin/reports", 303);
});

adminApp.get("/users", async (context) => {
  const q = context.req.query("q") ?? "";
  const [rows, open] = await Promise.all([
    database(context.env.DB)
      .select({
        id: t.users.id,
        name: t.users.name,
        githubId: t.users.githubId,
        isPublic: t.users.isPublic,
        adminHidden: t.users.adminHidden,
      })
      .from(t.users)
      .where(q === "" ? undefined : like(t.users.name, `%${q}%`))
      .orderBy(t.users.name)
      .limit(100),
    openReports(context.env),
  ]);
  return context.html(usersPage(context.get("admin"), rows, q, open));
});

adminApp.post("/users/hide", async (context) => {
  const admin = context.get("admin");
  const userId = Number(await field(context, "user_id"));
  const hidden = (await field(context, "hidden")) === "1" ? 1 : 0;
  const db = database(context.env.DB);
  await db
    .update(t.users)
    .set({ adminHidden: hidden })
    .where(eq(t.users.id, userId));
  const boards = ["play:board:week", "play:board:all"];
  const cats = await db
    .selectDistinct({ category: t.gameResults.category })
    .from(t.gameResults)
    .where(eq(t.gameResults.userId, userId));
  boards.push(...cats.map((c) => `play:catboard:${c.category}`));
  for (const key of boards)
    await context.env.CACHE.delete(key).catch(() => undefined);
  await logAction(
    context.env,
    admin,
    hidden === 1 ? "user.hide" : "user.show",
    String(userId),
  );
  return context.redirect("/admin/users", 303);
});
