// The TV page's entry: watches the room over its socket and draws the
// screen into #screen.
import { render } from "@solidjs/web";
import { createEffect, createRoot } from "solid-js";
import { roomSocket } from "../room/socket";
import { createScreen, type Screen as ScreenModel } from "./model";
import { Screen } from "./Screen";

const root = document.getElementById("screen")!;
const code = root.dataset.code!;
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`;

let screen!: ScreenModel;
const socket = roomSocket(wsUrl, {
  open: () => socket.send({ type: "watch" }),
  message: (message) => screen.receive(message),
  gone: () => {
    socket.stop();
    screen.close("This room has closed.");
  },
  moved: () => {},
});
screen = createScreen(socket);
screen.attach(document.getElementById("screen-clip") as HTMLAudioElement);

const sound = document.getElementById("screen-sound")!;
sound.addEventListener("click", () => screen.unlock());

createRoot(() => {
  createEffect(
    () => (screen.gone() ? "closed" : (screen.state()?.phase ?? "connecting")),
    (phase) => {
      root.dataset.phase = phase;
    },
  );
  createEffect(screen.live, (on) => {
    root.classList.toggle("is-live", on);
  });
  createEffect(screen.askSound, (on) => {
    sound.hidden = !on;
  });
});
render(() => <Screen screen={screen} code={code} />, root);
socket.open();
