// Drives the in-place swap of a [data-swap] link against two views of a page.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enableSwap } from "./swap";

const view = (period: string) => `
  <title>${period} · Earshot</title>
  <main id="main">
    <nav class="segmented" data-swap="main">
      <a href="/u/ada?period=week"${period === "week" ? ' aria-current="page"' : ""}>Week</a>
      <a href="/u/ada?period=month"${period === "month" ? ' aria-current="page"' : ""}>Month</a>
    </nav>
    <p id="figure">${period} plays</p>
  </main>`;

const fetchPage = vi.fn(async (input: RequestInfo | URL) => {
  const period = new URL(String(input)).searchParams.get("period") ?? "week";
  if (period === "gone") return new Response("", { status: 500 });
  return new Response(`<html><head></head><body>${view(period)}</body></html>`);
});
const assign = vi.fn();
const swapped = vi.fn();
const nextSwap = () =>
  new Promise<void>((resolve) => swapped.mockImplementationOnce(resolve));
const nextNavigation = () =>
  new Promise<void>((resolve) => assign.mockImplementationOnce(resolve));

const link = (name: string) =>
  [...document.querySelectorAll<HTMLAnchorElement>("[data-swap] a")].find(
    (a) => a.textContent === name,
  )!;

beforeAll(() => {
  history.replaceState(null, "", "/u/ada?period=week");
  document.body.innerHTML = view("week");
  vi.stubGlobal("fetch", fetchPage);
  vi.spyOn(location, "assign").mockImplementation(assign);
  enableSwap(swapped);
  prefetchedOnLoad = fetchPage.mock.calls.map(([input]) => String(input));
});
let prefetchedOnLoad: string[] = [];

beforeEach(() => {
  fetchPage.mockClear();
  assign.mockClear();
  swapped.mockClear();
});

describe("a [data-swap] link", () => {
  it("fetches the period choices not shown once the page has loaded", () => {
    expect(prefetchedOnLoad).toEqual([`${location.origin}/u/ada?period=month`]);
  });

  it("swaps the region, the address and the title without a reload", async () => {
    const swap = nextSwap();
    link("Month").click();
    await swap;
    expect(document.getElementById("figure")!.textContent).toBe("month plays");
    expect(location.search).toBe("?period=month");
    expect(document.title).toBe("month · Earshot");
    expect(document.activeElement).toBe(link("Month"));
    expect(assign).not.toHaveBeenCalled();
    expect(swapped).toHaveBeenCalledWith(document.getElementById("main"));
  });

  it("restores the view it left on Back", async () => {
    // happy-dom fires no popstate for a same-document Back, so the test does
    // what the browser does: restore the entry, then announce it.
    const state = { swap: "main" };
    history.replaceState(state, "", "/u/ada?period=week");
    const swap = nextSwap();
    dispatchEvent(new PopStateEvent("popstate", { state }));
    await swap;
    expect(document.getElementById("figure")!.textContent).toBe("week plays");
    expect(location.search).toBe("?period=week");
  });

  it("fetches the page once when the pointer rests on the link first", async () => {
    link("Month").dispatchEvent(new Event("pointerover", { bubbles: true }));
    const swap = nextSwap();
    link("Month").click();
    await swap;
    expect(document.getElementById("figure")!.textContent).toBe("month plays");
    expect(fetchPage).toHaveBeenCalledTimes(0);
  });

  it("navigates as a plain link when the page fails to load", async () => {
    const broken = document.createElement("a");
    broken.href = "/u/ada?period=gone";
    broken.textContent = "Broken";
    document.querySelector("[data-swap]")!.append(broken);
    const navigation = nextNavigation();
    broken.click();
    await navigation;
    expect(assign).toHaveBeenCalledWith(`${location.origin}/u/ada?period=gone`);
  });

  it("leaves a modified click to the browser", () => {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    link("Week").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
