// The room ended, or it is full and this device holds no seat; and the seat
// that moved to another device.
import { For, Show } from "solid-js";
import { DevicesIcon } from "./icons";
import type { Room } from "./model";
import { MonoStack } from "./parts";

export function Closed(props: { room: Room; hidden: boolean }) {
  const room = props.room;
  const r = () => room.room();
  const people = () => {
    const x = r();
    if (!x) return [];
    return x.type === "preview" ? x.players : x.players.map((p) => p.name);
  };
  return (
    <section class="room-closed" id="closed-panel" hidden={props.hidden}>
      <div class="room-closed-card">
        <p
          class="room-closed-code"
          id="closed-code"
          aria-hidden="true"
          hidden={room.full()}
        >
          <For each={[...room.code]}>{(char) => <span>{char}</span>}</For>
        </p>
        <MonoStack
          class="mono-stack room-closed-seats"
          id="closed-seats"
          hidden={!room.full() || !r()}
          names={people()}
        />
        <h1 class="room-closed-title" id="closed-title">
          {room.full() ? "This room is full" : "This room has closed"}
        </h1>
        <p class="room-closed-text" id="closed-text">
          {room.full()
            ? `All ${r()?.seats ?? 8} seats in ${r()?.category ? `${r()!.category} · ` : ""}${room.code} are taken. You can play the same category on your own.`
            : "The game here is over. Start a new one from any category on the hub."}
        </p>
        <Show when={room.full() && r()?.categorySlug}>
          <form method="post" action="/play" id="closed-solo">
            <input type="hidden" name="category" value={r()!.categorySlug} />
            <input type="hidden" name="mode" value={r()!.mode} />
            <button class="btn is-primary is-lg is-block" type="submit">
              Play {r()!.category} solo
            </button>
          </form>
        </Show>
        <a class="btn is-lg is-block room-closed-back" href="/">
          Back to the hub
        </a>
      </div>
    </section>
  );
}

export function Away(props: { room: Room; hidden: boolean }) {
  return (
    <section class="room-away" id="away-panel" hidden={props.hidden}>
      <div class="room-away-card">
        <span class="room-away-icon">
          <DevicesIcon />
        </span>
        <h1>Playing on your other device</h1>
        <p id="away-text">
          Your seat moved to another device, with your score and streak.
        </p>
        <button
          class="btn is-primary is-lg is-block"
          id="take-back"
          type="button"
          onClick={() => props.room.takeBack()}
        >
          Take the seat back here
        </button>
        <p class="room-away-note">
          The other device will show this screen instead.
        </p>
      </div>
    </section>
  );
}
