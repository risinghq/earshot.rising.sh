import { Hono } from "hono";
import { and, count, eq, isNull, like, or, sql } from "drizzle-orm";
import type { SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import type { Env } from "../env";
import { eraLabel } from "../play/catalog/eras";
import { saveTrackAnswer, setTrackBan } from "../play/catalog/edit";
import { notFoundPage } from "../ui/not-found";
import { PillButton } from "../ui/pill";
import { type AdminCategory, decadeChoices, findCategory } from "./categories";
import {
  adminPage,
  field,
  Group,
  logAction,
  openReports,
  type AdminEnv,
} from "./shell";

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

export const tracksApp = new Hono<AdminEnv>();

tracksApp.get("/categories/:slug/tracks", async (context) => {
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

tracksApp.post("/tracks/save", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const answerTitle = await field(context, "answer_title");
  const answerYear = Number(await field(context, "answer_year"));
  await saveTrackAnswer(context.env, trackKey, {
    title: answerTitle || null,
    year: Number.isInteger(answerYear) && answerYear > 0 ? answerYear : null,
  });
  await logAction(context.env, admin, "track.save", trackKey, slug);
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});

tracksApp.post("/tracks/ban", async (context) => {
  const admin = context.get("admin");
  const slug = await field(context, "category");
  const trackKey = await field(context, "track_key");
  const ban = (await field(context, "ban")) === "1";
  const reason = await field(context, "reason");
  await setTrackBan(
    context.env,
    trackKey,
    ban ? { reason: reason || null } : null,
  );
  await logAction(
    context.env,
    admin,
    ban ? "track.ban" : "track.unban",
    trackKey,
    slug,
  );
  return context.redirect(`/admin/categories/${slug}/tracks`, 303);
});
