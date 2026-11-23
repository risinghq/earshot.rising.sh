// The Devices sheet: put the room on a TV, or move this seat to another
// device. The seat link carries the seat's key, which only this device
// holds; the QR code comes from the server, which never stores it.
import { createEffect, createSignal } from "solid-js";
import { CloseIcon, CopyIcon, DevicesIcon, LockIcon, TvIcon } from "./icons";
import type { Room } from "./model";

export function DevicesButton(props: { room: Room; open: () => void }) {
  return (
    <button
      class="room-devices"
      type="button"
      data-devices
      data-tv={props.room.state()?.screen ? "" : undefined}
      aria-haspopup="dialog"
      onClick={() => props.open()}
    >
      <DevicesIcon />
      Devices
    </button>
  );
}

// Copies the field's value; where the clipboard is refused, selects it.
export function CopyButton(props: {
  id?: string;
  value: () => string;
  field: () => HTMLInputElement | undefined;
}) {
  const [copied, setCopied] = createSignal(false);
  const copy = () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard
        .writeText(props.value())
        .then(done, () => props.field()?.select());
    else props.field()?.select();
  };
  return (
    <button class="room-copy" id={props.id} type="button" onClick={copy}>
      <CopyIcon />
      <span>{copied() ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function LinkField(props: { id: string; label: string; value: string }) {
  let field: HTMLInputElement | undefined;
  return (
    <div class="room-share">
      <label class="sr-only" for={props.id}>
        {props.label}
      </label>
      <input
        class="room-link"
        id={props.id}
        type="text"
        readonly
        value={props.value}
        ref={(el) => (field = el)}
        onFocus={(event) => event.currentTarget.select()}
      />
      <CopyButton value={() => props.value} field={() => field} />
    </div>
  );
}

export function DevicesSheet(props: {
  room: Room;
  // Counts up each time the sheet should open.
  openings: number;
}) {
  const room = props.room;
  let sheet!: HTMLDialogElement;
  const [key, setKey] = createSignal("");
  const screen = `/play/room/${room.code}/screen`;
  const seat = () => {
    const url = new URL(`/play/room/${room.code}`, location.origin);
    url.searchParams.set("k", key());
    return url.href;
  };

  createEffect(
    () => props.openings,
    (n) => {
      if (n === 0) return;
      setKey(room.token() ?? "");
      sheet.showModal();
    },
  );
  // A seat that moved away takes its sheet with it.
  createEffect(
    () => room.view() === "away",
    (away) => {
      if (away && sheet.open) sheet.close();
    },
  );

  return (
    <dialog
      class="pick-sheet room-sheet"
      id="devices-sheet"
      aria-labelledby="devices-title"
      ref={(el) => (sheet = el)}
      onClick={(event) => {
        // A tap on the backdrop lands on the dialog itself.
        if (event.target === sheet) sheet.close();
      }}
    >
      <span class="pick-grab" aria-hidden="true" />
      <div class="pick-head">
        <h2 id="devices-title">Devices</h2>
        <button
          class="pick-close"
          id="devices-close"
          type="button"
          aria-label="Close"
          onClick={() => sheet.close()}
        >
          <CloseIcon />
        </button>
      </div>
      <section class="room-dev-item" aria-labelledby="dev-tv">
        <h3 id="dev-tv">Show on a TV</h3>
        <p id="dev-tv-note">
          Open this link in the TV’s browser. While it is open, the clips play
          there and phones only answer.
        </p>
        <LinkField
          id="tv-link"
          label="TV link"
          value={new URL(screen, location.origin).href}
        />
        <a class="btn is-block" href={screen} target="_blank" rel="noopener">
          <TvIcon />
          Open the TV screen here
        </a>
      </section>
      <section class="room-dev-item is-move" aria-labelledby="dev-move">
        <img
          class="room-dev-qr"
          id="seat-qr"
          alt=""
          width={112}
          height={112}
          src={
            key()
              ? `/play/room/${room.code}/seat.svg?k=${encodeURIComponent(key())}`
              : undefined
          }
        />
        <div class="room-dev-text">
          <h3 id="dev-move">Move to another device</h3>
          <p>
            Scan the code or open the link there. Your seat moves with your
            score and streak.
          </p>
        </div>
        <LinkField id="seat-link" label="Your seat link" value={seat()} />
        <p class="room-seat-warn">
          <LockIcon />
          This link is your seat. Don’t share it: whoever opens it plays as you.
        </p>
      </section>
    </dialog>
  );
}
