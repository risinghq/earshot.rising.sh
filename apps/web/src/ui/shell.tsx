import type { Child } from "hono/jsx";
import type { SignedInUser } from "../auth";

export type NavSection = "play" | "board" | "party";

interface PageOptions {
  title: string;
  head?: Child;
  user?: SignedInUser | null;
  nav?: NavSection;
  footer?: Child;
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
  children,
}: PageOptions) {
  const current = (section: NavSection) =>
    nav === section ? { "aria-current": "page" } : {};
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
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="site-header">
          <div class="wrap">
            <a class="site-name" href="/">
              Earshot
            </a>
            <nav class="site-nav" aria-label="Site">
              <a href="/play" {...current("play")}>
                Play
              </a>
              <a href="/play/board" {...current("board")}>
                Board
              </a>
              <a href="/party" {...current("party")}>
                Party
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
        <main class="wrap shell" id="main">
          {children}
        </main>
        {footer && <footer class="wrap footer">{footer}</footer>}
      </body>
    </html>
  );
}
