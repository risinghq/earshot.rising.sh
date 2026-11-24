// The pick sheet's state. A player suggests the next game; the host plays
// the pick after a game or sets it in the lobby. Genres load once per
// visit. Artist search runs as you type: 250 ms after the last key, and a
// newer query aborts the older request.
import { createSignal } from "solid-js";
import type { Mode } from "../../src/play/game/rules";
import type { PickPurpose } from "./text";

export interface PickItem {
  slug: string;
  name: string;
  picture?: string;
  fans?: number;
}

type Tab = "genre" | "artist";

export function createPicker(
  fetchJson: (url: string, signal?: AbortSignal) => Promise<unknown>,
) {
  const [purpose, setPurpose] = createSignal<PickPurpose>("suggest");
  const [tab, setTab] = createSignal<Tab>("genre");
  const [choice, setChoice] = createSignal<PickItem | null>(null);
  const [mode, setMode] = createSignal<Mode>("normal");
  const [genres, setGenres] = createSignal<PickItem[] | null>(null);
  const [artists, setArtists] = createSignal<PickItem[]>([]);
  const [status, setStatus] = createSignal("");
  // Counts up each time the sheet should open.
  const [openings, setOpenings] = createSignal(0);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;

  function loadGenres() {
    setGenres([]);
    setStatus("Loading genres…");
    fetchJson("/play/picks")
      .then((body) => {
        setGenres((body as { genres?: PickItem[] }).genres ?? []);
        setStatus("");
      })
      .catch(() => {
        setGenres(null);
        setStatus("Genres did not load. Close and try again.");
      });
  }

  function showTab(next: Tab) {
    setTab(next);
    setChoice(null);
    if (next === "genre" && genres() === null) loadGenres();
  }

  function open(next: PickPurpose, startTab: Tab, roomMode: Mode) {
    setPurpose(next);
    setMode(roomMode);
    showTab(startTab);
    setOpenings((n) => n + 1);
  }

  function search(text: string) {
    const query = text.trim();
    abort?.abort();
    clearTimeout(timer);
    if (query === "") {
      setArtists([]);
      setStatus("");
      return;
    }
    timer = setTimeout(() => {
      const controller = new AbortController();
      abort = controller;
      setStatus("Searching…");
      fetchJson(`/play/picks?q=${encodeURIComponent(query)}`, controller.signal)
        .then((body) => {
          const found = (body as { artists?: PickItem[] }).artists ?? [];
          setArtists(found);
          setStatus(found.length ? "" : `No artist matches “${query}”.`);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setArtists([]);
          setStatus(
            "Artist search is not answering. Try a genre, or search again.",
          );
        });
    }, 250);
  }

  return {
    purpose,
    tab,
    choice,
    mode,
    genres,
    artists,
    status,
    openings,
    open,
    showTab,
    search,
    choose: (item: PickItem) => setChoice({ slug: item.slug, name: item.name }),
    setMode,
  };
}

export type Picker = ReturnType<typeof createPicker>;
