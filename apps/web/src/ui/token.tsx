const copyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

// The Copy button appears only where the clipboard API exists (client/site.ts
// shows it), so a page without JavaScript leaves the field to select by hand.
export function TokenField({ token, label }: { token: string; label: string }) {
  return (
    <input
      class="field"
      id="issued-token"
      value={token}
      aria-label={label}
      readonly
      spellcheck={false}
    />
  );
}

export function CopyButton({
  label = "Copy",
  className = "btn is-form",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <button class={className} type="button" data-copy="issued-token" hidden>
      {copyIcon}
      <span>{label}</span>
    </button>
  );
}

export function TokenDisplay({
  token,
  label,
  primary = false,
}: {
  token: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <div class="token-row">
      <TokenField token={token} label={label} />
      <CopyButton
        className={primary ? "btn is-primary is-form" : "btn is-form"}
      />
    </div>
  );
}
