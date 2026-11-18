import type { Child } from "hono/jsx";
import type { SignedInUser } from "../auth";

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

export function Page({
  title,
  head,
  user,
  nav,
  footer,
  chrome = "full",
  children,
}: PageOptions) {
  const current = (section: NavSection) =>
    nav === section ? { "aria-current": "page" } : {};
  const siteHeader = (
    <header class="site-header">
      <div class="wrap">
        <a class="site-name" href="/">
          <svg class="sound-mark" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="1" y="7" width="2.4" height="5" rx="1.2" />
            <rect x="5.2" y="3.5" width="2.4" height="11" rx="1.2" />
            <rect x="9.4" y="5.5" width="2.4" height="7" rx="1.2" />
            <rect x="13.6" y="4" width="2.4" height="10" rx="1.2" />
          </svg>
          Earshot
        </a>
        <nav class="site-nav" aria-label="Site">
          <a href="/play" {...current("play")}>
            Play
          </a>
          <a href="/play/board" {...current("board")}>
            Board
          </a>
          <a href="/groups" {...current("groups")}>
            Groups
          </a>
        </nav>
        {user ? (
          <details class="account">
            <summary>
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
          <a class="pill" href="/auth/github">
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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {head}
        <link
          rel="preload"
          href="/inter-latin.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="stylesheet" href="/styles.css" />
        <script src="/site.js" defer />
        <title>{`${title} · Earshot`}</title>
      </head>
      <body class={chrome === "game" ? "in-game" : ""}>
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
