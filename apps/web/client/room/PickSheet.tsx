// The sheet that picks the room's next category.
import { For, Show, createEffect, flush } from "solid-js";
import { modeNames, modes } from "../../src/play/rules";
import { CloseIcon, SearchIcon } from "./icons";
import type { Room } from "./model";
import type { PickItem, Picker } from "./picker";
import { number, pickButton, pickTitles } from "./text";

function Row(props: { picker: Picker; item: PickItem; top: boolean }) {
  const item = () => props.item;
  return (
    <li>
      <button
        type="button"
        class={{ "pick-hit": true, "is-top": props.top }}
        aria-pressed={
          props.picker.choice()?.slug === item().slug ? "true" : "false"
        }
        onClick={() => props.picker.choose(item())}
      >
        <Show
          when={item().picture}
          fallback={<span class="pick-art">{[...item().name][0] ?? "?"}</span>}
        >
          <img class="pick-art" src={item().picture} alt="" loading="lazy" />
        </Show>
        <span class="pick-text">
          <Show when={props.top}>
            <small class="pick-kicker">Top hit</small>
          </Show>
          <b>{item().name}</b>
          <Show when={item().fans !== undefined}>
            <small>{number(item().fans!)} fans</small>
          </Show>
        </span>
      </button>
    </li>
  );
}

export function PickSheet(props: { room: Room; picker: Picker }) {
  const room = props.room;
  const picker = props.picker;
  let sheet!: HTMLDialogElement;
  let query!: HTMLInputElement;
  let go!: HTMLButtonElement;
  const items = () =>
    picker.tab() === "genre"
      ? (picker.genres() ?? []).filter(
          (g) => g.slug !== room.room()?.categorySlug,
        )
      : picker.artists();

  createEffect(
    () => picker.openings(),
    (n) => {
      if (n === 0) return;
      sheet.showModal();
      if (picker.tab() === "artist") query.focus();
    },
  );

  function tab(next: "genre" | "artist") {
    picker.showTab(next);
    flush();
    if (next === "artist") query.focus();
  }

  function submit() {
    const choice = picker.choice();
    if (choice === null) return;
    if (picker.purpose() === "suggest")
      room.suggest(choice.slug, picker.mode());
    else room.switchTo(choice.slug, picker.mode(), picker.purpose() === "next");
    sheet.close();
  }

  return (
    <dialog
      class="pick-sheet"
      id="pick-sheet"
      aria-labelledby="pick-title"
      ref={(el) => (sheet = el)}
      onClick={(event) => {
        // A tap on the backdrop lands on the dialog itself.
        if (event.target === sheet) sheet.close();
      }}
    >
      <span class="pick-grab" aria-hidden="true" />
      <div class="pick-head">
        <h2 id="pick-title">{pickTitles[picker.purpose()]}</h2>
        <button
          class="pick-close"
          id="pick-close"
          type="button"
          aria-label="Close"
          onClick={() => sheet.close()}
        >
          <CloseIcon />
        </button>
      </div>
      <div class="pick-tabs" role="tablist" aria-label="Pick from">
        <button
          type="button"
          role="tab"
          id="pick-tab-genre"
          data-tab="genre"
          aria-selected={picker.tab() === "genre" ? "true" : "false"}
          onClick={() => tab("genre")}
        >
          Genre
        </button>
        <button
          type="button"
          role="tab"
          id="pick-tab-artist"
          data-tab="artist"
          aria-selected={picker.tab() === "artist" ? "true" : "false"}
          onClick={() => tab("artist")}
        >
          Artist
        </button>
      </div>
      <label
        class="pick-search"
        id="pick-search"
        hidden={picker.tab() !== "artist"}
      >
        <SearchIcon />
        <span class="sr-only">Artist</span>
        <input
          type="search"
          id="pick-q"
          placeholder="Search an artist"
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          ref={(el) => (query = el)}
          onInput={(event) => picker.search(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter takes the top hit, so a typed name and Enter is enough.
            const [first] = picker.artists();
            if (event.key !== "Enter" || !first) return;
            event.preventDefault();
            picker.choose(first);
            flush();
            go.focus();
          }}
        />
      </label>
      <p class="pick-status" id="pick-status" aria-live="polite">
        {picker.status()}
      </p>
      <ul class="pick-results" id="pick-list">
        <For each={items()}>
          {(item, i) => (
            <Row
              picker={picker}
              item={item}
              top={picker.tab() === "artist" && i() === 0}
            />
          )}
        </For>
      </ul>
      <div class="pick-modes" role="group" aria-label="Mode">
        <For each={modes}>
          {(mode) => (
            <button
              type="button"
              data-mode={mode}
              aria-pressed={picker.mode() === mode ? "true" : "false"}
              onClick={() => picker.setMode(mode)}
            >
              {modeNames[mode]}
            </button>
          )}
        </For>
      </div>
      <button
        class="btn is-primary is-lg is-block"
        id="pick-go"
        type="button"
        disabled={picker.choice() === null}
        ref={(el) => (go = el)}
        onClick={submit}
      >
        {pickButton(
          picker.purpose(),
          picker.tab(),
          picker.choice()?.name ?? null,
          picker.mode(),
        )}
      </button>
      <a class="pick-hub" id="pick-hub" href={`/?room=${room.code}`}>
        Pick an era on the hub
      </a>
    </dialog>
  );
}
