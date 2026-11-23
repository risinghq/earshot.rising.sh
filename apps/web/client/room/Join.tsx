// The invite: the room's category and who is in, and the nickname form for a
// guest the room could not seat on arrival.
import { Show, createEffect, createSignal } from "solid-js";
import type { Room } from "./model";
import { MonoStack, Mosaic, Part } from "./parts";
import { modeLabels, whoIsIn } from "./text";

export function Join(props: { room: Room; hidden: boolean }) {
  const room = props.room;
  const [length, setLength] = createSignal(0);
  let nickname!: HTMLInputElement;
  const people = () => {
    const r = room.room();
    if (!r) return [];
    return r.type === "preview" ? r.players : r.players.map((p) => p.name);
  };

  createEffect(
    () => room.askName(),
    (n) => {
      if (n > 0) nickname.focus({ preventScroll: true });
    },
  );

  return (
    <section class="room-join" id="join-panel" hidden={props.hidden}>
      <div class="room-invite is-join">
        <Mosaic seed={room.room()?.categorySlug ?? ""} />
        <div class="room-invite-head">
          <p class="room-label">You’re invited · Room {room.code}</p>
          <h1 class="room-invite-title">{room.room()?.category}</h1>
          <p class="room-invite-sub" id="join-mode">
            {room.room()
              ? `${modeLabels[room.room()!.mode]} · ${room.room()!.rounds} rounds`
              : ""}
          </p>
        </div>
      </div>
      <p class="room-who" id="join-who" hidden={people().length === 0}>
        <MonoStack names={people().slice(0, 4)} />
        <span class="room-who-text">
          {whoIsIn(people(), room.room()?.seats ?? 0)}
        </span>
      </p>
      <form
        id="join-form"
        class="room-join-card"
        onSubmit={(event) => {
          event.preventDefault();
          room.join(nickname.value);
        }}
      >
        <h2 class="room-join-title">Pick a nickname</h2>
        <p class="room-note">
          1–20 characters. This device remembers it for the next room.
        </p>
        <div class="room-field">
          <label class="sr-only" for="nickname">
            Nickname
          </label>
          <input
            class="field"
            id="nickname"
            name="nickname"
            type="text"
            minlength={1}
            maxlength={20}
            autocomplete="nickname"
            placeholder="Your nickname"
            required
            ref={(el) => (nickname = el)}
            onInput={(event) =>
              setLength([...event.currentTarget.value].length)
            }
          />
          <span class="room-field-count" id="nickname-count">
            {length()}/20
          </span>
        </div>
        <button class="btn is-primary is-lg is-block" type="submit">
          Join the room <kbd class="room-kbd">Enter</kbd>
        </button>
        <Show when={!room.signedIn}>
          <p class="room-or">or</p>
          <Part name="sign-in" />
          <p class="room-note is-center">
            Play under your profile name and keep your points.
          </p>
        </Show>
      </form>
    </section>
  );
}
