// The design's name hash: the same name always gets the same hue, so a
// person keeps one colour on every board, list and group.
export function hueOf(text: string) {
  return [...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
}

const hueStyle = (text: string, size?: number) =>
  size === undefined
    ? `--hue:${hueOf(text)}`
    : `--hue:${hueOf(text)};--s:${size}px`;

export function Monogram({
  name,
  size,
  waiting = false,
}: {
  name: string;
  size?: number;
  waiting?: boolean;
}) {
  return (
    <span
      class={waiting ? "mono is-waiting" : "mono"}
      style={hueStyle(name, size)}
      aria-hidden="true"
    >
      {[...name][0] ?? "?"}
    </span>
  );
}

export function MonoStack({ names }: { names: string[] }) {
  return (
    <span class="mono-stack" aria-hidden="true">
      {names.map((name) => (
        <Monogram name={name} />
      ))}
    </span>
  );
}

export function Mosaic({ seed, size }: { seed: string; size?: number }) {
  return (
    <span class="mosaic" style={hueStyle(seed, size)} aria-hidden="true" />
  );
}

// The colour tile shows until the image loads, and stays when there is none.
export function Cover({
  seed,
  src = null,
  disc = false,
}: {
  seed: string;
  src?: string | null;
  disc?: boolean;
}) {
  return (
    <span
      class={disc ? "cover is-disc" : "cover"}
      style={hueStyle(seed)}
      aria-hidden="true"
    >
      {src && <img src={src} alt="" loading="lazy" decoding="async" />}
    </span>
  );
}

export const soundMark = (
  <svg class="sound-mark" viewBox="0 0 18 18" aria-hidden="true">
    <rect x="1" y="7" width="2.4" height="5" rx="1.2" />
    <rect x="5.2" y="3.5" width="2.4" height="11" rx="1.2" />
    <rect x="9.4" y="5.5" width="2.4" height="7" rx="1.2" />
    <rect x="13.6" y="4" width="2.4" height="10" rx="1.2" />
  </svg>
);

export const chevronLeft = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const playIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
  </svg>
);

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a class="back-link" href={href}>
      {chevronLeft}
      {label}
    </a>
  );
}
