import { Hono } from "hono";
import { eq, like } from "drizzle-orm";
import { hasGithub, type SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import { forgetBoardsOf } from "../play/game/results";
import { PillButton } from "../ui/pill";
import {
  adminPage,
  field,
  Group,
  logAction,
  openReports,
  type AdminEnv,
} from "./shell";

type UserRow = Pick<
  typeof t.users.$inferSelect,
  "id" | "name" | "githubId" | "isPublic" | "adminHidden" | "tier"
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
                {row.tier === "paid" && <span class="badge accent">paid</span>}
              </span>
              <form method="post" action={`/admin/users/${row.id}/tier`}>
                <input
                  type="hidden"
                  name="tier"
                  value={row.tier === "paid" ? "free" : "paid"}
                />
                <PillButton
                  variant={row.tier === "paid" ? "ghost" : "outline"}
                  small
                >
                  {row.tier === "paid" ? "Revoke paid" : "Grant paid"}
                </PillButton>
              </form>
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

export const usersApp = new Hono<AdminEnv>();

usersApp.get("/users", async (context) => {
  const q = context.req.query("q") ?? "";
  const [rows, open] = await Promise.all([
    database(context.env.DB)
      .select({
        id: t.users.id,
        name: t.users.name,
        githubId: t.users.githubId,
        isPublic: t.users.isPublic,
        adminHidden: t.users.adminHidden,
        tier: t.users.tier,
      })
      .from(t.users)
      .where(q === "" ? undefined : like(t.users.name, `%${q}%`))
      .orderBy(t.users.name)
      .limit(100),
    openReports(context.env),
  ]);
  return context.html(usersPage(context.get("admin"), rows, q, open));
});

usersApp.post("/users/hide", async (context) => {
  const admin = context.get("admin");
  const userId = Number(await field(context, "user_id"));
  const hidden = (await field(context, "hidden")) === "1" ? 1 : 0;
  await database(context.env.DB)
    .update(t.users)
    .set({ adminHidden: hidden })
    .where(eq(t.users.id, userId));
  await forgetBoardsOf(context.env, userId);
  await logAction(
    context.env,
    admin,
    hidden === 1 ? "user.hide" : "user.show",
    String(userId),
  );
  return context.redirect("/admin/users", 303);
});

usersApp.post("/users/:id/tier", async (context) => {
  const admin = context.get("admin");
  const userId = Number(context.req.param("id"));
  const tier = await field(context, "tier");
  if (!Number.isInteger(userId) || (tier !== "free" && tier !== "paid"))
    return context.text("bad tier grant", 400);
  await database(context.env.DB)
    .update(t.users)
    .set({ tier })
    .where(eq(t.users.id, userId));
  await logAction(context.env, admin, "user.tier", String(userId), tier);
  return context.redirect("/admin/users", 303);
});
