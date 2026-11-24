// Reads a rendered page the way a browser would see it, so a test can assert
// what a visitor can follow instead of matching markup text.

// label is the accessible name, worked out as for a PageButton.
export interface PageLink {
  href: string;
  label: string;
  // The data-swap value of the region the link sits in, if any.
  swap: string | null;
  current: boolean;
}

// A button that submits its form. action is where it posts: its formaction,
// else the form's. label is the accessible name: aria-label, or the text
// inside without its aria-hidden parts.
export interface PageButton {
  action: string;
  name: string | null;
  value: string;
  label: string;
  disabled: boolean;
}

// A form a visitor can submit: where it posts, the values its fields send
// before anyone types (a radio or checkbox only when checked), the option
// values each select offers, and the buttons that submit it.
export interface PageForm {
  action: string;
  fields: Record<string, string>;
  choices: Record<string, string[]>;
  buttons: PageButton[];
}

export interface ReadPage {
  links: PageLink[];
  forms: PageForm[];
  ids: Set<string>;
  // The data-* attributes of each element with an id, keyed without the
  // "data-" prefix: the state the client scripts read from that region.
  data: Map<string, Record<string, string>>;
  // What a reader sees: text outside script, style and template, entities
  // decoded, whitespace collapsed.
  text: string;
  // The aria-label values a screen reader announces.
  labels: string[];
  // The src of each image, in page order.
  images: string[];
  // Every input, in or out of a form, by its aria-label.
  inputs: { label: string; value: string }[];
  // Each meta tag's content by its property or name, as a link preview reads.
  meta: Map<string, string>;
  speculation: SpeculationRules | null;
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text: string) {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    },
  );
}

const squash = (text: string) => decode(text).replace(/\s+/g, " ").trim();

// HTMLRewriter hands attribute values over as written, entities and all.
function attr(element: Element, name: string) {
  const value = element.getAttribute(name);
  return value === null ? null : decode(value);
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
  const forms: PageForm[] = [];
  const ids = new Set<string>();
  const data = new Map<string, Record<string, string>>();
  const labels: string[] = [];
  const images: string[] = [];
  const inputs: ReadPage["inputs"] = [];
  const meta = new Map<string, string>();
  const swaps: string[] = [];
  let text = "";
  let hidden = 0;
  // Depth inside aria-hidden="true", which leaves an accessible name.
  let muted = 0;
  // The link or submit button being read, collecting its accessible name.
  let named: { text: string; done: { label: string } } | null = null;
  const nameFrom = (done: { label: string }) => {
    if (done.label !== "") return;
    named = { text: "", done };
    atEnd(() => {
      done.label = squash(named!.text);
      named = null;
    });
  };
  let rules = "";
  let inRules = false;
  let select: string | null = null;
  // An element keeps only the last onEndTag handler it is given, so handlers
  // queue their end-tag work here and the last handler registers it once.
  let ends: (() => void)[] = [];
  const atEnd = (work: () => void) => void ends.push(work);
  const url = (path: string | null) => new URL(path ?? "", base).href;
  await new HTMLRewriter()
    .on("[id]", {
      element(element) {
        const id = attr(element, "id")!;
        ids.add(id);
        const values: Record<string, string> = {};
        for (const [name, value] of element.attributes)
          if (name.startsWith("data-")) values[name.slice(5)] = decode(value);
        data.set(id, values);
      },
    })
    .on("[aria-label]", {
      element(element) {
        labels.push(attr(element, "aria-label")!);
      },
    })
    // An opening tag separates words, as a block or a line break would.
    .on("*", {
      element() {
        text += " ";
        if (named) named.text += " ";
      },
    })
    .on("script, style, template", {
      element() {
        hidden += 1;
        atEnd(() => void (hidden -= 1));
      },
    })
    .on('[aria-hidden="true"]', {
      element() {
        muted += 1;
        atEnd(() => void (muted -= 1));
      },
    })
    .on("img[src]", {
      element(element) {
        images.push(url(attr(element, "src")));
      },
    })
    .on("meta[content]", {
      element(element) {
        const key = attr(element, "property") ?? attr(element, "name");
        if (key !== null) meta.set(key, attr(element, "content")!);
      },
    })
    .on("input", {
      element(element) {
        inputs.push({
          label: attr(element, "aria-label") ?? "",
          value: attr(element, "value") ?? "",
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (hidden > 0) return;
        text += chunk.text;
        if (named && muted === 0) named.text += chunk.text;
      },
    })
    .on("[data-swap]", {
      element(element) {
        swaps.push(attr(element, "data-swap")!);
        atEnd(() => void swaps.pop());
      },
    })
    .on("form", {
      element(element) {
        forms.push({
          action: url(attr(element, "action")),
          fields: {},
          choices: {},
          buttons: [],
        });
      },
    })
    .on("form input[name]", {
      element(element) {
        const type = attr(element, "type");
        if (
          (type === "radio" || type === "checkbox") &&
          !element.hasAttribute("checked")
        )
          return;
        forms.at(-1)!.fields[attr(element, "name")!] =
          attr(element, "value") ?? (type === "checkbox" ? "on" : "");
      },
    })
    .on("form button", {
      element(element) {
        if (attr(element, "type") === "button") return;
        const formaction = attr(element, "formaction");
        const done: PageButton = {
          action: formaction === null ? forms.at(-1)!.action : url(formaction),
          name: attr(element, "name"),
          value: attr(element, "value") ?? "",
          label: squash(attr(element, "aria-label") ?? ""),
          disabled: element.hasAttribute("disabled"),
        };
        forms.at(-1)!.buttons.push(done);
        nameFrom(done);
      },
    })
    .on("form select[name]", {
      element(element) {
        const name = attr(element, "name")!;
        forms.at(-1)!.choices[name] = [];
        select = name;
        atEnd(() => void (select = null));
      },
    })
    // The site's options all carry a value attribute.
    .on("form select option[value]", {
      element(element) {
        if (select !== null)
          forms.at(-1)!.choices[select]!.push(attr(element, "value")!);
      },
    })
    .on("a[href]", {
      element(element) {
        const link: PageLink = {
          href: url(attr(element, "href")),
          label: squash(attr(element, "aria-label") ?? ""),
          swap: swaps.at(-1) ?? null,
          current: attr(element, "aria-current") === "page",
        };
        links.push(link);
        nameFrom(link);
      },
    })
    .on('script[type="speculationrules"]', {
      element() {
        inRules = true;
        atEnd(() => void (inRules = false));
      },
      text(chunk) {
        if (inRules) rules += chunk.text;
      },
    })
    .on("*", {
      element(element) {
        if (ends.length === 0) return;
        const work = ends;
        ends = [];
        element.onEndTag(() => work.forEach((done) => done()));
      },
    })
    .transform(new Response(html))
    .text();
  return {
    links,
    forms,
    ids,
    data,
    text: squash(text),
    labels,
    images,
    inputs,
    meta,
    speculation: rules === "" ? null : (JSON.parse(rules) as SpeculationRules),
  };
}

// The text each element matching selector shows, in page order: a locator for
// a value the page displays without a label of its own, such as a score.
export async function textAt(html: string, selector: string) {
  const found: string[] = [];
  let depth = 0;
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        if (depth === 0) found.push("");
        depth += 1;
        element.onEndTag(() => void (depth -= 1));
      },
    })
    .on("*", {
      element() {
        if (depth > 0) found[found.length - 1] += " ";
      },
    })
    .onDocument({
      text(chunk) {
        if (depth > 0) found[found.length - 1] += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found.map(squash);
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
