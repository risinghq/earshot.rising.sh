// The lobby: the room's link to share, a sound check, the players and open
// seats, and the host's controls.
import { For, Repeat, Show } from "solid-js";
import type { RoomPlayer, RoomState } from "../../src/play/room/protocol";
import { CopyButton } from "./Devices";
import { ChevronIcon, ShareIcon, SoundOffIcon, TvIcon } from "./icons";
import type { Room } from "./model";
import { Mono, Mosaic } from "../ui/marks";
import { Tag, WaitRow } from "./parts";
import { host, modeLabels, plural } from "./text";

function Person(props: { player: RoomPlayer; you: string }) {
  const p = () => props.player;
  const mine = () => p().name === props.you;
  return (
    <li
      class={mine() ? "is-you" : ""}
      data-away={p().connected ? undefined : ""}
    >
      <Mono name={p().name} />
      <span class="room-person">
        <b>{p().name}</b>
        <small>{p().user ? "Signed in" : "Guest"}</small>
      </span>
      <span class="room-tags">
        <Show when={mine()}>
          <Tag kind="you">You</Tag>
        </Show>
        <Show when={p().creator}>
          <Tag kind="host">Host</Tag>
        </Show>
        <Show when={!p().connected}>
          <Tag kind="away">Away</Tag>
        </Show>
      </span>
    </li>
  );
}

// The open seats: dashed circles and a count on a phone, a box per seat
// from 900px.
function Seats(props: { s: RoomState }) {
  const open = () => props.s.seats - props.s.players.length;
  return (
    <Show when={open() > 0}>
      <li class="room-seats">
        <span class="room-seat-list" aria-hidden="true">
          <Repeat count={open()}>
            {(i) => (
              <span class="room-seat">
                Seat {props.s.players.length + 1 + i}
              </span>
            )}
          </Repeat>
        </span>
        <span class="room-seat-count">
          {plural(open(), "seat", "seats")} open
        </span>
      </li>
    </Show>
  );
}

export function Lobby(props: {
  room: Room;
  hidden: boolean;
  openPicker: () => void;
}) {
  const room = props.room;
  const s = () => room.state();
  const url = `${location.origin}/play/room/${room.code}`;
  let link: HTMLInputElement | undefined;
  const creator = () => s()?.you.creator ?? false;
  const share = () =>
    navigator
      .share({ title: "Earshot", text: "Join my Earshot room", url })
      .catch(() => {});

  return (
    <section class="room-lobby" id="lobby-panel" hidden={props.hidden}>
      <div class="room-lobby-main">
        <div class="room-invite">
          <div class="room-invite-top">
            <Mosaic seed={s()?.categorySlug ?? ""} />
            <div class="room-invite-head">
              <h1 class="room-invite-title">{s()?.category}</h1>
              <p class="room-invite-sub" id="lobby-mode">
                {s() ? modeLabels[s()!.mode] : ""}
              </p>
            </div>
          </div>
          <div class="room-code-row">
            <p class="room-label">Room code</p>
            <p class="room-code">{room.code}</p>
          </div>
          <div class="room-share">
            <label class="sr-only" for="room-link">
              Room link
            </label>
            <input
              class="room-link"
              id="room-link"
              type="text"
              readonly
              value={url}
              ref={(el) => (link = el)}
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton id="copy-link" value={() => url} field={() => link} />
            <Show when={"share" in navigator}>
              <button
                class="room-share-native"
                id="share-link"
                type="button"
                onClick={share}
              >
                <ShareIcon />
                Share
              </button>
            </Show>
          </div>
        </div>
        <div class="room-sound" id="sound-check" hidden={room.clip.unlocked()}>
          <span class="room-sound-icon">
            <SoundOffIcon />
          </span>
          <p>
            <strong>Sound is off here.</strong> Rounds start on every device at
            once. Tap once so this one can play them.
          </p>
          <button
            class="room-sound-on"
            id="sound-on"
            type="button"
            onClick={() => room.clip.unlock()}
          >
            Turn on sound
          </button>
        </div>
      </div>
      <div class="room-lobby-side">
        <section class="room-players">
          <h2 class="room-players-head">
            Players{" "}
            <small id="players-count">
              {s() ? `${s()!.players.length} of ${s()!.seats}` : ""}
            </small>
          </h2>
          <ul class="room-people" id="lobby-players">
            <For each={s()?.players ?? []} keyed={(p) => p.name}>
              {(p) => <Person player={p()} you={s()?.you.name ?? ""} />}
            </For>
            <Show when={s()}>{(state) => <Seats s={state()} />}</Show>
          </ul>
        </section>
        <a class="room-tv" href={`/play/room/${room.code}/screen`}>
          <TvIcon />
          <span>
            <strong>Show the room on a TV</strong>
            <small>Playing in one place? The clips play there.</small>
          </span>
          <ChevronIcon />
        </a>
        <div class="results-actions room-actions" id="lobby-actions">
          <button
            class="pill large"
            id="change-category"
            type="button"
            hidden={!creator()}
            onClick={() => props.openPicker()}
          >
            Change category
          </button>
          <button
            class="pill primary large"
            id="start-button"
            type="button"
            hidden={!creator()}
            onClick={() => room.start()}
          >
            Start the game <kbd class="room-kbd">Enter</kbd>
          </button>
          <Show
            when={s()?.kind === "match"}
            fallback={
              <WaitRow
                id="lobby-wait"
                hidden={creator()}
                host={s() ? host(s()!) : undefined}
                what="start the game"
              />
            }
          >
            <WaitRow
              id="lobby-wait"
              hidden={creator()}
              text="The game starts once everyone is connected."
            />
          </Show>
        </div>
      </div>
    </section>
  );
}
