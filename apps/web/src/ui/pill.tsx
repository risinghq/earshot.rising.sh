import type { Child } from "hono/jsx";

export type PillVariant = "default" | "primary" | "danger";

interface PillLinkOptions {
  href: string;
  variant?: PillVariant;
  id?: string;
  small?: boolean;
  large?: boolean;
  dataName?: string;
  children: Child;
}

export function PillLink({
  href,
  variant = "default",
  id,
  small,
  large,
  dataName,
  children,
}: PillLinkOptions) {
  const cls = `pill${variant === "default" ? "" : ` ${variant}`}${small ? " small" : ""}${large ? " large" : ""}`;
  return (
    <a class={cls} href={href} id={id} data-name={dataName}>
      {children}
    </a>
  );
}

interface PillButtonOptions {
  variant?: PillVariant;
  type?: "submit" | "button";
  small?: boolean;
  large?: boolean;
  children: Child;
}

export function PillButton({
  variant = "default",
  type = "submit",
  small,
  large,
  children,
}: PillButtonOptions) {
  const cls = `pill${variant === "default" ? "" : ` ${variant}`}${small ? " small" : ""}${large ? " large" : ""}`;
  return (
    <button class={cls} type={type}>
      {children}
    </button>
  );
}
