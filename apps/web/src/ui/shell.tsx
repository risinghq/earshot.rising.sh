import type { Child } from "hono/jsx";
import type { SignedInUser } from "../auth";

interface PageOptions {
  title: string;
  head?: Child;
  user?: SignedInUser | null;
  footer?: Child;
  children: Child;
}

export function Page({ title, head, user, footer, children }: PageOptions) {
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
        <title>{`${title} · Earshot`}</title>
      </head>
      <body>
        <header class="site-header">
          <div class="wrap">
            <a class="site-name" href="/">
              Earshot
            </a>
            <nav class="site-nav" aria-label="Site">
              <a href="/play">Play</a>
              <a href="/play/board">Board</a>
              <a href="/party">Party</a>
              {user ? (
                <>
                  <a href={`/u/${encodeURIComponent(user.name)}`}>
                    {user.name}
                  </a>
                  <a href="/settings">Settings</a>
                </>
              ) : (
                <a href="/auth/github">Sign in</a>
              )}
            </nav>
          </div>
        </header>
        <main class="wrap shell">{children}</main>
        {footer && <footer class="wrap footer">{footer}</footer>}
      </body>
    </html>
  );
}
