// The room's WebSocket. It reconnects a second after any close, except the
// two that end the visit: the room closed, or the seat moved to another
// device.
import {
  closeCodes,
  type ClientMessage,
  type ServerMessage,
} from "../../src/play/room/protocol";

export interface SocketEvents {
  open: () => void;
  message: (message: ServerMessage) => void;
  gone: () => void;
  moved: () => void;
}

export function roomSocket(url: string, on: SocketEvents) {
  let ws: WebSocket | undefined;
  let stopped = false;

  const open = () => {
    stopped = false;
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = () => on.open();
    socket.onmessage = (event) =>
      on.message(JSON.parse(String(event.data)) as ServerMessage);
    socket.onclose = (event) => {
      if (event.code === closeCodes.gone) on.gone();
      if (event.code === closeCodes.moved) on.moved();
      if (!stopped) setTimeout(open, 1000);
    };
  };

  return {
    open,
    send(message: ClientMessage) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    // Stops reconnecting; the visit is over until open() again.
    stop() {
      stopped = true;
    },
    close() {
      stopped = true;
      ws?.close();
    },
  };
}

export type RoomSocket = ReturnType<typeof roomSocket>;
