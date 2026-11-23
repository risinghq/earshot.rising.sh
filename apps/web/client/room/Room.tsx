// The room page's live part. The server renders the shell (#game with the
// room code, the quit dialog and the parts it owns); this draws every view
// into it. All views stay mounted and toggle `hidden`, so the stage's
// <audio> lives for the whole visit: a phone that unlocked sound once keeps
// it for every round.
import { createSignal } from "solid-js";
import { Bar } from "./Bar";
import { Away, Closed } from "./Closed";
import { DevicesButton, DevicesSheet } from "./Devices";
import { Done } from "./Done";
import { QuitIcon } from "./icons";
import { Join } from "./Join";
import { Lobby } from "./Lobby";
import type { Room as RoomModel } from "./model";
import { PickSheet } from "./PickSheet";
import type { Picker } from "./picker";
import { Round } from "./Round";

export function Room(props: {
  room: RoomModel;
  picker: Picker;
  boardDays: string;
}) {
  const room = props.room;
  const picker = props.picker;
  const [devices, setDevices] = createSignal(0);
  const openDevices = () => setDevices((n) => n + 1);
  const mode = () => room.room()?.mode ?? "normal";
  const view = room.view;
  const name = () => {
    const s = room.state();
    return s?.you.name
      ? `${s.category} · Room ${room.code}`
      : `Room ${room.code}`;
  };

  return (
    <>
      <Bar room={room} openDevices={openDevices} />
      <div class="results-head">
        <a class="results-quit" href="/" aria-label="Leave the room">
          <QuitIcon />
        </a>
        <b id="room-name">{name()}</b>
        <DevicesButton room={room} open={openDevices} />
      </div>
      <p
        class="form-error room-error"
        id="room-error"
        hidden={room.error() === ""}
      >
        {room.error()}
      </p>
      <Join room={room} hidden={view() !== "join"} />
      <Lobby
        room={room}
        hidden={view() !== "lobby"}
        openPicker={() => picker.open("set", "genre", mode())}
      />
      <Round room={room} hidden={view() !== "round"} />
      <Done
        room={room}
        hidden={view() !== "done"}
        boardDays={props.boardDays}
        openPicker={(tab) =>
          picker.open(
            room.state()?.you.creator ? "next" : "suggest",
            tab,
            mode(),
          )
        }
      />
      <Closed room={room} hidden={view() !== "closed"} />
      <Away room={room} hidden={view() !== "away"} />
      <PickSheet room={room} picker={picker} />
      <DevicesSheet room={room} openings={devices()} />
    </>
  );
}
