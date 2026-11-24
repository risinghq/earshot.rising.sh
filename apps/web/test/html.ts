// Reads a rendered page the way a browser would see it, so a test can assert
// what a visitor can follow instead of matching markup text.

export interface PageLink {
  href: string;
  // The data-swap value of the region the link sits in, if any.
  swap: string | null;
  current: boolean;
}

export interface ReadPage {
  links: PageLink[];
  ids: Set<string>;
  speculation: SpeculationRules | null;
}

interface Where {
  href_matches?: string | string[];
  not?: Where;
  and?: Where[];
  selector_matches?: string;
}

export interface SpeculationRules {
  prefetch?: { where: Where; eagerness: string }[];
  prerender?: { where: Where; eagerness: string }[];
}

export async function readPage(html: string, base: string): Promise<ReadPage> {
  const links: PageLink[] = [];
  const ids = new Set<string>();
  const swaps: string[] = [];
  let rules = "";
  let inRules = false;
  await new HTMLRewriter()
    .on("[id]", {
      element(element) {
        ids.add(element.getAttribute("id")!);
      },
    })
    .on("[data-swap]", {
      element(element) {
        swaps.push(element.getAttribute("data-swap")!);
        element.onEndTag(() => void swaps.pop());
      },
    })
    .on("a[href]", {
      element(element) {
        links.push({
          href: new URL(element.getAttribute("href")!, base).href,
          swap: swaps.at(-1) ?? null,
          current: element.getAttribute("aria-current") === "page",
        });
      },
    })
    .on('script[type="speculationrules"]', {
      element(element) {
        inRules = true;
        element.onEndTag(() => void (inRules = false));
      },
      text(chunk) {
        if (inRules) rules += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return {
    links,
    ids,
    speculation: rules === "" ? null : (JSON.parse(rules) as SpeculationRules),
  };
}

// Whether Chromium would act on a link under a speculation rule's where
// clause. selector_matches is limited to "[data-swap] a", the one selector the
// site uses.
export function speculates(where: Where, link: PageLink): boolean {
  if (where.and) return where.and.every((part) => speculates(part, link));
  if (where.not) return !speculates(where.not, link);
  if (where.selector_matches !== undefined) {
    if (where.selector_matches !== "[data-swap] a")
      throw new Error(`unsupported selector ${where.selector_matches}`);
    return link.swap !== null;
  }
  const patterns = [where.href_matches ?? []].flat();
  return patterns.some((pattern) =>
    new URLPattern(pattern, link.href).test(link.href),
  );
}
