import type { Child } from "hono/jsx";
import type { SignedInUser } from "../auth";
import { fontUrl, ScriptTag, Styles, type Style } from "./assets";
import { Monogram } from "./person";

export type NavSection = "play" | "board" | "groups";

interface PageOptions {
  title: string;
  head?: Child;
  user?: SignedInUser | null;
  nav?: NavSection;
  footer?: Child;
  // "game" drops the site header: while a game runs the page shows only the
  // game, with its own top bar rendered by the page's children.
  chrome?: "full" | "game";
  // The page's stylesheets. Site pages need common and site; a game page
  // adds game.
  styles?: Style[];
  bodyClass?: string;
  children: Child;
}

const caret = (
  <svg class="account-caret" viewBox="0 0 12 12" aria-hidden="true" fill="none">
    <path
      d="M3 4.5l3 3 3-3"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
);

// The icons show only where the nav becomes the phone's bottom tab bar.
const navIcon = (path: string) => (
  <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
);
const navIcons: Record<NavSection, Child> = {
  play: navIcon(
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 14.5v-9l6 4.5-6 4.5z",
  ),
  board: navIcon(
    "M7 3h10v2h4v3a5 5 0 0 1-4.6 5A5 5 0 0 1 13 15.9V18h3v3H8v-3h3v-2.1A5 5 0 0 1 7.6 13 5 5 0 0 1 3 8V5h4V3zm0 4H5v1a3 3 0 0 0 2 2.8V7zm12 0h-2v3.8A3 3 0 0 0 19 8V7z",
  ),
  groups: navIcon(
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM1 20c0-3.3 3.6-6 8-6s8 2.7 8 6v1H1v-1zm17.2 1H23v-1c0-2.6-2.4-4.6-5.6-5 1.5 1.3 2.4 3 2.4 5v1h-1.6z",
  ),
};

export const soundMark = (
  <svg class="sound-mark" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="1" y="7" width="2.4" height="5" rx="1.2" />
    <rect x="5.2" y="3.5" width="2.4" height="11" rx="1.2" />
    <rect x="9.4" y="5.5" width="2.4" height="7" rx="1.2" />
    <rect x="13.6" y="4" width="2.4" height="10" rx="1.2" />
  </svg>
);

export function Page({
  title,
  head,
  user,
  nav,
  footer,
  chrome = "full",
  styles = chrome === "game" ? ["common", "site", "game"] : ["common", "site"],
  bodyClass,
  children,
}: PageOptions) {
  const current = (section: NavSection) =>
    nav === section ? { "aria-current": "page" } : {};
  const siteHeader = (
    <header class="site-header">
      <div class="wrap">
        <a class="site-name" href="/">
          {soundMark}
          Earshot
        </a>
        <nav class="site-nav" aria-label="Site">
          <a href="/" {...current("play")}>
            {navIcons.play}
            Play
          </a>
          <a href="/play/board" {...current("board")}>
            {navIcons.board}
            Board
          </a>
          <a href="/groups" {...current("groups")}>
            {navIcons.groups}
            Groups
          </a>
        </nav>
        {user ? (
          <details class="account">
            <summary>
              <Monogram name={user.name} />
              <span class="account-name">{user.name}</span>
              {caret}
            </summary>
            <div class="account-menu">
              <a href={`/u/${encodeURIComponent(user.name)}`}>Profile</a>
              <a href="/friends">Friends</a>
              <a href="/settings">Settings</a>
              <form method="post" action="/settings/sign-out">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </details>
        ) : (
          <a class="pill" href="/sign-in">
            Sign in
          </a>
        )}
      </div>
    </header>
  );
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        {head}
        <link
          rel="preload"
          href={fontUrl}
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Styles names={styles} />
        <ScriptTag name="site" />
        <title>{`${title} · Earshot`}</title>
      </head>
      <body
        class={
          [chrome === "game" ? "in-game" : "", bodyClass ?? ""]
            .filter(Boolean)
            .join(" ") || undefined
        }
      >
        <a class="skip" href="#main">
          Skip to content
        </a>
        {chrome === "full" && siteHeader}
        <main
          class={chrome === "game" ? "wrap shell game-shell" : "wrap shell"}
          id="main"
        >
          {children}
        </main>
        {footer && <footer class="wrap footer">{footer}</footer>}
      </body>
    </html>
  );
}
