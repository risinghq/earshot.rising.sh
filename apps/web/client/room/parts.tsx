// Small pieces the room's views share.
import { For, Show } from "solid-js";
import type { Choice } from "../../src/play/game/rules";
import { Mono } from "../ui/marks";

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

// The same label the server renders in round-page.tsx choiceLabel.
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
