import type { SignedInUser } from "../account/auth";
import { EmptyState } from "./empty";
import { Page } from "./shell";

export function notFoundPage(user: SignedInUser | null = null) {
  return Page({
    title: "Not found",
    user,
    children: (
      <EmptyState
        title="Page not found"
        body="The page you asked for does not exist."
        action={{ href: "/", label: "Back to the start page" }}
        heading="h1"
      />
    ),
  });
}
