import type { Child } from "hono/jsx";
import { providerHref } from "../auth";

interface EmptyStateOptions {
  title: string;
  body?: Child;
  action?: { href: string; label: string };
  heading?: "h1" | "h2";
  art?: Child;
}

export function EmptyState({
  title,
  body,
  action,
  heading = "h2",
  art,
}: EmptyStateOptions) {
  const Title = heading;
  return (
    <div class="empty-card">
      {art}
      <Title>{title}</Title>
      {body && <p>{body}</p>}
      {action && (
        <a class="btn is-primary" href={action.href}>
          {action.label}
        </a>
      )}
    </div>
  );
}

export const plusIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const githubIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
  </svg>
);

// Google's sign-in guidelines ask for the four-colour G on a button.
const googleIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.28 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l4.01-3.11z"
    />
    <path
      fill="#EA4335"
      d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.53 11.53 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z"
    />
  </svg>
);

// Two blank people and a plus: the art for "people you have not met here".
export const circlesArt = (
  <span class="circles" aria-hidden="true">
    <span class="mono" style="--hue:230" />
    <span class="mono" style="--hue:175" />
    <span class="plus">{plusIcon}</span>
  </span>
);

// The provider returns the visitor to `next` after sign-in; auth.ts keeps it.
export function SignInButtons({ next }: { next: string }) {
  return (
    <div class="sign-in-buttons">
      <a class="btn is-ink is-lg is-block" href={providerHref("github", next)}>
        {githubIcon}
        Sign in with GitHub
      </a>
      <a class="btn is-lg is-block" href={providerHref("google", next)}>
        {googleIcon}
        Sign in with Google
      </a>
    </div>
  );
}

export function SignInCard({
  title,
  body,
  next,
}: {
  title: string;
  body: string;
  next: string;
}) {
  return (
    <div class="signed-out">
      <div class="empty-card">
        {circlesArt}
        <h1>{title}</h1>
        <p>{body}</p>
        <SignInButtons next={next} />
        <p class="after">You come back to this page after.</p>
      </div>
    </div>
  );
}
