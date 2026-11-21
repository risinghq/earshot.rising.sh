import type { Child } from "hono/jsx";
import { signInHref } from "../auth";

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

// Two blank people and a plus: the art for "people you have not met here".
export const circlesArt = (
  <span class="circles" aria-hidden="true">
    <span class="mono" style="--hue:230" />
    <span class="mono" style="--hue:175" />
    <span class="plus">{plusIcon}</span>
  </span>
);

// GitHub returns the visitor to `next` after sign-in; auth.ts keeps it.
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
        <a class="btn is-ink is-lg is-block" href={signInHref(next)}>
          {githubIcon}
          Sign in with GitHub
        </a>
        <p class="after">You come back to this page after.</p>
      </div>
    </div>
  );
}
