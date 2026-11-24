// A link inside [data-swap="ID"] leads to another view of the same page, such
// as a profile's period. Following it fetches that page and swaps in its
// element with that id, so the header and the scroll stay. A pointer over the
// link, a press, keyboard focus or an idle page starts the fetch, so the click
// usually finds the page ready. Back and Forward swap too. Without JavaScript,
// or when the fetch fails, the link navigates as usual.
const freshMs = 60_000;

const linkIn = (target: EventTarget | null) => {
  const link = (target as Element | null)?.closest?.<HTMLAnchorElement>(
    "[data-swap] a[href]",
  );
  return link && link.origin === location.origin ? link : null;
};

const plainClick = (event: MouseEvent) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

// onSwapped wires behaviour the new region's markup needs.
export function enableSwap(
  onSwapped: (region: HTMLElement) => void = () => {},
) {
  const pages = new Map<string, { at: number; page: Promise<Document> }>();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const load = (url: string) => {
    const hit = pages.get(url);
    if (hit && Date.now() - hit.at < freshMs) return hit.page;
    const page = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status}`);
      return new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
    });
    page.catch(() => pages.delete(url));
    pages.set(url, { at: Date.now(), page });
    return page;
  };
  const prefetch = (url: string) => void load(url).catch(() => undefined);

  // A phone has no hover, and a period control holds two or three choices,
  // so those are fetched once the page is idle.
  const prefetchChoices = () =>
    document
      .querySelectorAll<HTMLAnchorElement>(
        "nav.segmented[data-swap] a:not([aria-current])",
      )
      .forEach((link) => prefetch(link.href));

  const keepLeaving = (id: string) => {
    if (history.state?.swap === undefined)
      history.replaceState({ ...history.state, swap: id }, "");
    const left = document.implementation.createHTMLDocument(document.title);
    left.body.append(document.getElementById(id)!.cloneNode(true));
    pages.set(location.href, { at: Date.now(), page: Promise.resolve(left) });
  };

  async function swapTo(url: string, id: string, push: boolean) {
    try {
      const page = await load(url);
      const fresh = page.getElementById(id);
      const current = document.getElementById(id);
      if (!fresh || !current) throw new Error("no region");
      // The parsed page stays cached for Back, so the swap inserts a copy.
      const region = document.importNode(fresh, true);
      const apply = () => {
        current.replaceWith(region);
        document.title = page.title;
        if (push) history.pushState({ swap: id }, "", url);
        onSwapped(region);
      };
      if (document.startViewTransition && !reducedMotion.matches)
        await document.startViewTransition(apply).updateCallbackDone;
      else apply();
      // Focus stays on the control that was used, now the current one.
      [...region.querySelectorAll<HTMLAnchorElement>("[data-swap] a[href]")]
        .find((link) => link.href === url)
        ?.focus({ preventScroll: true });
      prefetchChoices();
    } catch {
      location.assign(url);
    }
  }

  for (const type of ["pointerover", "pointerdown", "focusin"] as const)
    document.addEventListener(
      type,
      (event) => {
        const link = linkIn(event.target);
        if (link && link.href !== location.href) prefetch(link.href);
      },
      { passive: true },
    );

  document.addEventListener("click", (event) => {
    const link = linkIn(event.target);
    if (!link || !plainClick(event)) return;
    event.preventDefault();
    if (link.href === location.href) return;
    const id = link.closest<HTMLElement>("[data-swap]")!.dataset.swap!;
    // The view being left is kept, so Back swaps it in at once.
    keepLeaving(id);
    void swapTo(link.href, id, true);
  });

  addEventListener("popstate", (event) => {
    const id = (event.state as { swap?: string } | null)?.swap;
    if (id) void swapTo(location.href, id, false);
  });

  // Safari has no requestIdleCallback. After load the page's own resources
  // are done, which is the part of idle that matters here.
  if ("requestIdleCallback" in window) requestIdleCallback(prefetchChoices);
  else if (document.readyState === "complete") prefetchChoices();
  else addEventListener("load", prefetchChoices, { once: true });
}
