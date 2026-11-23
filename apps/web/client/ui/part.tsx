// Markup the server owns and renders once into the page's
// <template data-parts>: sign-in links, the save card, the TV's QR code.
// Each part is the content of a [data-part] wrapper; each use takes a fresh
// copy, and ref receives its first element.
export function Part(props: { name: string; ref?: (el: HTMLElement) => void }) {
  const template = document.querySelector("template[data-parts]");
  const source =
    template instanceof HTMLTemplateElement
      ? template.content.querySelector(`[data-part="${props.name}"]`)
      : null;
  if (!source) return null;
  const nodes = [...source.childNodes].map((node) => node.cloneNode(true));
  const first = nodes.find((node) => node.nodeType === Node.ELEMENT_NODE);
  if (first) props.ref?.(first as HTMLElement);
  return nodes;
}
