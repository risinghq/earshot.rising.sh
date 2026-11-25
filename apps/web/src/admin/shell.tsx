import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { isNull } from "drizzle-orm";
import type { SignedInUser } from "../account/auth";
import { database, t } from "../platform/db";
import type { Env } from "../env";
import { Page } from "../ui/shell";

export type AdminEnv = {
  Bindings: Env;
  Variables: { admin: SignedInUser };
};

export type AdminContext = Context<AdminEnv>;
export function adminIds(env: Env) {
  return new Set(
    (env.ADMIN_GITHUB_IDS ?? "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

export async function logAction(
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

export async function field(context: AdminContext, name: string) {
  const body = await context.req.parseBody();
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

type AdminSection = "categories" | "reports" | "users";

export function openReports(env: Env) {
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

export function adminPage(
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

export function Group({
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
