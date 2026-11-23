// The room page's entry: reads the shell the server rendered, opens the
// room socket and draws the room into #game.
import { render } from "@solidjs/web";
import { createEffect, createRoot } from "solid-js";
import { createClip } from "./clip";
import { createRoom, type Room as RoomModel } from "./model";
import { createPicker } from "./picker";
import { Room } from "./Room";
import { roomSocket } from "./socket";
import { topPick } from "./text";

const root = document.getElementById("game")!;
const code = root.dataset.code!;

// A seat link carries the seat's key: keep it and take it out of the
// address bar, so a shared screenshot or copied URL never carries it.
const key = new URLSearchParams(location.search).get("k");
if (key) {
  localStorage.setItem(`quiz-room-${code}`, key);
  history.replaceState(null, "", `/play/room/${code}`);
}

const fetchJson = (url: string, signal?: AbortSignal) =>
  fetch(url, { signal }).then((response) =>
    response.ok
      ? response.json()
      : Promise.reject(new Error(String(response.status))),
  );

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`;

function start() {
  let room!: RoomModel;
  const socket = roomSocket(wsUrl, {
    open: () => room.arrive(),
    message: (message) => room.receive(message),
    gone: () => room.closed(),
    moved: () => room.away(),
  });
  room = createRoom({
    code,
    signedIn: root.dataset.user === "1",
    clip: createClip(matchMedia("(prefers-reduced-motion: reduce)").matches),
    send: socket.send,
    stop: socket.stop,
    close: socket.close,
    reopen: socket.open,
    post: (path, body) => fetch(path, { method: "POST", body }),
  });
  const picker = createPicker(fetchJson);

  createRoot(() =>
    createEffect(room.view, (view) => {
      root.dataset.phase = view;
    }),
  );
  render(
    () => (
      <Room
        room={room}
        picker={picker}
        boardDays={root.dataset.boardDays ?? ""}
      />
    ),
    root,
  );
  document.addEventListener("keydown", (event) => keys(event, room));
  socket.open();
}

// Keyboard: 1-4 answers while the choices are open, Space plays or
// pauses, and Enter starts the game, plays the top vote or the rematch for
// the host.
function keys(event: KeyboardEvent, room: RoomModel) {
  if (event.repeat || document.querySelector("dialog[open]")) return;
  const target = event.target as Element | null;
  if (target?.closest?.("input, textarea, select")) return;
  const onControl = Boolean(target?.closest?.("button, a, summary"));
  const s = room.state();
  if (event.key === "Enter" && !onControl) {
    if (!s?.you.creator) return;
    const view = room.view();
    if (view === "lobby") room.start();
    else if (view === "done" && room.doneStep() === "next") {
      const top = topPick(s);
      if (!top) return;
      room.switchTo(top.slug, top.mode, true);
    } else if (view === "done") room.start();
    else return;
    event.preventDefault();
    return;
  }
  if (room.view() !== "round") return;
  if (/^[1-4]$/.test(event.key)) {
    const choice = s?.choices?.[Number(event.key) - 1];
    if (choice && s?.mode !== "hard") room.pick(choice.title);
  } else if (event.key === " " && !onControl) {
    event.preventDefault();
    room.clip.toggle();
  }
}

start();
