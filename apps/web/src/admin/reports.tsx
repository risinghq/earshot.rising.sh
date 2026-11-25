import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import { PillButton } from "../ui/pill";
import { adminPage, field, Group, logAction, type AdminEnv } from "./shell";

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

export const reportsApp = new Hono<AdminEnv>();

reportsApp.get("/reports", async (context) => {
  const reports = await database(context.env.DB)
    .select()
    .from(t.trackReports)
    .where(isNull(t.trackReports.resolvedAt))
    .orderBy(desc(t.trackReports.createdAt));
  return context.html(reportsPage(context.get("admin"), reports));
});

reportsApp.post("/reports/resolve", async (context) => {
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
