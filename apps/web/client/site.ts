import { enableSwap } from "./swap";

// Progressive enhancement only: the <details> account menu already opens and
// closes with keyboard and pointer. This closes it on outside click, Escape,
// or after picking an item, which <details> does not do on its own.
const account = document.querySelector<HTMLDetailsElement>("details.account");
if (account) {
  document.addEventListener("click", (event) => {
    if (account.open && !account.contains(event.target as Node))
      account.open = false;
  });
  account.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      account.open = false;
      account.querySelector("summary")?.focus();
    }
  });
  account.addEventListener("toggle", () => {
    if (account.open)
      account.querySelector<HTMLElement>(".account-menu a")?.focus();
  });
  account
    .querySelectorAll(".account-menu a, .account-menu button")
    .forEach((item) =>
      item.addEventListener("click", () => (account.open = false)),
    );
}

// A [data-copy] button copies the value of the field it names. It shows only
// where the clipboard API exists.
const showCopy = (scope: ParentNode) => {
  if (!navigator.clipboard) return;
  scope
    .querySelectorAll<HTMLElement>("[data-copy]")
    .forEach((button) => (button.hidden = false));
};
showCopy(document);
document.addEventListener("click", async (event) => {
  const button = (event.target as Element | null)?.closest?.<HTMLElement>(
    "[data-copy]",
  );
  if (!button) return;
  const field = document.getElementById(button.dataset.copy ?? "");
  if (!(field instanceof HTMLInputElement)) return;
  await navigator.clipboard.writeText(field.value);
  const label = button.querySelector("span") ?? button;
  label.textContent = "Copied";
});

// A form marked data-inline="ID" posts over fetch and swaps in the element
// with that id from the page the server answers with, so the page keeps its
// place instead of reloading. Without JavaScript the form posts as usual.
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const id = form.dataset.inline;
  if (!id || event.defaultPrevented) return;
  event.preventDefault();
  const button = event.submitter as HTMLButtonElement | null;
  if (button) button.disabled = true;
  const body = new URLSearchParams(
    new FormData(form, button) as unknown as Record<string, string>,
  );
  try {
    const response = await fetch(form.action, { method: "POST", body });
    const page = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const fresh = page.getElementById(id);
    const current = document.getElementById(id);
    if (!fresh || !current) throw new Error("no region");
    current.replaceWith(fresh);
    showCopy(fresh);
    // Keep focus in the region: a button that went away hands it to the
    // region's first control.
    fresh
      .querySelector<HTMLElement>("[autofocus], .notice, button, input")
      ?.focus({ preventScroll: true });
  } catch {
    if (button) button.disabled = false;
    form.submit();
  }
});

enableSwap(showCopy);
