import { Hono } from "hono";
import { countDistinct, eq, sql } from "drizzle-orm";
import type { SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import type { Env } from "../env";
import { eraLabel, generations } from "../play/catalog/eras";
import {
  addSource,
  createCategory,
  removeSource,
  saveCategory,
} from "../play/catalog/edit";
import {
  fillMissingYears,
  refreshCategorySources,
  type CategorySource,
} from "../play/catalog/refresh";
import { deezerPlaylistInfo } from "../play/catalog/sources";
import { notFoundPage } from "../ui/not-found";
import { PillButton } from "../ui/pill";
import {
  adminPage,
  field,
  Group,
  logAction,
  openReports,
  type AdminEnv,
} from "./shell";

export type AdminCategory = typeof t.categories.$inferSelect & {
  tracks?: number;
};

export async function findCategory(env: Env, slug: string) {
  const category = await database(env.DB)
    .select()
    .from(t.categories)
    .where(eq(t.categories.slug, slug))
    .get();
  return category ?? null;
}

export function categorySources(env: Env, slug: string) {
  return database(env.DB)
    .select()
    .from(t.categorySources)
    .where(eq(t.categorySources.category, slug))
    .orderBy(t.categorySources.position, t.categorySources.id);
}

export const decadeChoices = [
  "1960",
  "1970",
  "1980",
  "1990",
  "2000",
  "2010",
  "2020",
  ...Object.keys(generations),
].sort();

function kindLabel(kind: string) {
  return kind.replaceAll("_", " ");
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

export const categoriesApp = new Hono<AdminEnv>();

categoriesApp.get("/", async (context) => {
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

categoriesApp.post("/categories", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "slug");
  const name = await field(context, "name");
  if (!/^[a-z0-9-]+$/.test(slug) || name === "")
    return context.text(
      "A slug is lowercase letters, digits and hyphens.",
      400,
    );
  if (!(await createCategory(context.env, slug, name)))
    return context.text("That slug is taken.", 400);
  await logAction(context.env, admin, "category.create", slug, name);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

categoriesApp.post("/categories/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "slug");
  const name = await field(context, "name");
  const position = Number(await field(context, "position"));
  const hidden = (await context.req.parseBody()).hidden === "on" ? 1 : 0;
  if (name === "" || !Number.isInteger(position))
    return context.text("Name and order are required.", 400);
  await saveCategory(context.env, slug, { name, position, hidden });
  await logAction(
    context.env,
    admin,
    "category.save",
    slug,
    `name=${name} position=${position} hidden=${hidden}`,
  );
  return context.redirect(`/admin/categories/${slug}`, 303);
});

categoriesApp.get("/categories/:slug", async (context) => {
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

categoriesApp.post("/sources/lookup", async (context) => {
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

categoriesApp.post("/sources", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const ref = await field(context, "ref");
  const title = await field(context, "title");
  const tracksCount = Number(await field(context, "tracks_count"));
  const decadeRaw = await field(context, "decade");
  const decade = /^\d{4}$/.test(decadeRaw) ? Number(decadeRaw) : null;
  if (!/^\d{4,}$/.test(ref)) return context.text("Bad playlist id.", 400);
  const added = await addSource(context.env, slug, {
    ref,
    title: title || null,
    tracksCount: Number.isInteger(tracksCount) ? tracksCount : null,
    decade,
  });
  if (!added) return context.text("That source is already listed.", 400);
  await logAction(context.env, admin, "source.add", slug, ref);
  return context.redirect(`/admin/categories/${slug}`, 303);
});

categoriesApp.post("/sources/remove", async (context) => {
  const admin = context.get("admin");
  const id = Number(await field(context, "id"));
  const slug = await field(context, "category");
  await removeSource(context.env, slug, id);
  await logAction(context.env, admin, "source.remove", slug, String(id));
  return context.redirect(`/admin/categories/${slug}`, 303);
});

categoriesApp.post("/refresh", async (context) => {
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
