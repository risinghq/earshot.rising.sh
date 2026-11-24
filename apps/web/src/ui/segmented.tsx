import type { Child } from "hono/jsx";

export interface SegmentOption {
  label: string;
  href: string;
  current: boolean;
  badge?: Child;
}

// stage sets the control on the dark stage card. swap names the element that
// a choice replaces in place, through client/swap.ts.
export function Segmented({
  label,
  options,
  stage = false,
  swap,
}: {
  label: string;
  options: SegmentOption[];
  stage?: boolean;
  swap?: string;
}) {
  return (
    <nav
      class={stage ? "segmented is-stage" : "segmented"}
      aria-label={label}
      data-swap={swap}
    >
      {options.map((option) => (
        <a
          href={option.href}
          aria-current={option.current ? "page" : undefined}
        >
          {option.label}
          {option.badge !== undefined && (
            <span class="badge">{option.badge}</span>
          )}
        </a>
      ))}
    </nav>
  );
}
