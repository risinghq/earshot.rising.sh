// Small pieces every room view uses.
import { For, Show } from "solid-js";
import type { Choice } from "../../src/play/rules";
import { hueOf } from "../../src/ui/marks";

// A person's monogram, in the hue the server pages give the same name.
export function Mono(props: { name: string; size?: number }) {
  return (
    <span
      class="mono"
      style={{
        "--hue": String(hueOf(props.name)),
        "--s": props.size ? `${props.size}px` : undefined,
      }}
      aria-hidden="true"
    >
      {[...props.name][0] ?? "?"}
    </span>
  );
}

export function MonoStack(props: {
  names: string[];
  class?: string;
  id?: string;
  hidden?: boolean;
}) {
  return (
    <span
      class={props.class ?? "mono-stack"}
      id={props.id}
      hidden={props.hidden}
      aria-hidden="true"
    >
      <For each={props.names}>{(name) => <Mono name={name} />}</For>
    </span>
  );
}

export function Mosaic(props: { seed: string }) {
  return (
    <span
      class="mosaic"
      style={{ "--hue": String(hueOf(props.seed)) }}
      aria-hidden="true"
    />
  );
}

export function Tag(props: {
  kind: "you" | "host" | "away";
  children: string;
}) {
  return <span class={`room-tag is-${props.kind}`}>{props.children}</span>;
}

// "Waiting for Ana to start the game." with the host's monogram and dots.
export function WaitRow(props: {
  id: string;
  hidden: boolean;
  host?: string;
  what?: string;
  text?: string;
}) {
  return (
    <p class="room-wait" id={props.id} hidden={props.hidden}>
      <Show when={props.host !== undefined && props.what !== undefined}>
        <Mono name={props.host!} size={36} />
      </Show>
      <span class="room-wait-text">
        <Show when={props.what !== undefined} fallback={props.text}>
          Waiting for <strong>{props.host ?? "the host"}</strong> to{" "}
          {props.what}.
        </Show>
      </span>
      <span class="room-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </p>
  );
}

// Markup the server owns and renders once into <template id="room-parts">:
// the sign-in buttons, the save-score card and the board's sign-in line.
// Each part is the content of a [data-part] wrapper; each use takes a
// fresh copy, and ref receives its first element.
export function Part(props: { name: string; ref?: (el: HTMLElement) => void }) {
  const template = document.getElementById("room-parts");
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

// The same label the server renders in pages.tsx choiceLabel.
export function ChoiceLabel(props: { choice: Choice }) {
  return (
    <span class="choice-label">
      <span class="choice-title">{props.choice.title}</span>
      <Show when={props.choice.artist}>
        <span class="choice-artist">{props.choice.artist}</span>
      </Show>
    </span>
  );
}
