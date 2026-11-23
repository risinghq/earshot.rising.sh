// The room's phone page. The server sends the whole room state on every
// change; render() shows the panel for its phase and fills it. The round
// reuses the solo round's markup, and the stage and its <audio> persist
// across rounds so a phone that unlocked sound once keeps it.
import { clipWave } from "./wave.js";

const root = document.getElementById("game");
const code = root.dataset.code;
const $ = (id) => document.getElementById(id);
const show = (el, on) => {
  if (el) el.hidden = !on;
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const number = (value) => value.toLocaleString("en-US");
const ordinal = (n) =>
  n +
  (["th", "st", "nd", "rd"][
    (n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10
  ] ?? "th");
const modeLabels = {
  easy: "Easy · titles with artists",
  normal: "Normal · titles only",
  hard: "Hard · type the title",
};
const modeNames = { easy: "Easy", normal: "Normal", hard: "Hard" };
const roundMs = 15000;
// Mirrors scoreFor in src/play/quiz.ts: 1000 at the start, 100 at the end.
const worthAt = (ms) => (ms > 0 ? Math.round(100 + (900 * ms) / roundMs) : 0);
// The worth falls 60 points a second; a slower redraw moves it in visible,
// uneven jumps.
const tickMs = 50;
const byline = (song) =>
  song.original ? `${song.original} · ${song.artist}` : song.artist;
const linkService = (link) =>
  link.includes("apple.com") ? "Apple Music" : "Deezer";
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fromTemplate = (id) => $(id).content.firstElementChild.cloneNode(true);
// "a", "a and b", "a, b and c".
const names = (list) =>
  list.length < 2
    ? list.join("")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

// The same hash as hueOf in src/ui/person.tsx, so a person and a category
// keep the colours the server pages give them.
const hueOf = (text) =>
  [...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
const mono = (name, size) => {
  const span = el("span", "mono", [...name][0] ?? "?");
  span.style.setProperty("--hue", String(hueOf(name)));
  if (size) span.style.setProperty("--s", `${size}px`);
  span.setAttribute("aria-hidden", "true");
  return span;
};
const monoStack = (list, people) =>
  list.replaceChildren(...people.map((n) => mono(n)));

// The same label the server renders in pages.tsx choiceLabel.
const choiceLabel = (choice) => {
  const label = el("span", "choice-label");
  label.append(el("span", "choice-title", choice.title));
  if (choice.artist) label.append(el("span", "choice-artist", choice.artist));
  return label;
};

const tokenKey = `quiz-room-${code}`;
const nicknameKey = "earshot-nickname";
const signedIn = root.dataset.user === "1";
const params = new URLSearchParams(location.search);
if (params.get("k")) {
  localStorage.setItem(tokenKey, params.get("k"));
  history.replaceState(null, "", `/play/room/${code}`);
}
const roomUrl = `${location.origin}/play/room/${code}`;
$("room-link").value = roomUrl;

let ws;
let gone = false;
let typedJoin = false; // the last join carried a nickname the player typed
let offset = 0; // server time minus local time
let tickTimer = null;
let playTimer = null;
let shownRound = 0; // the round number the stage was last set up for
let openedRound = 0; // the round whose answers are open
let revealedRound = 0;
let answered = false;
let loadedFor = 0; // the round number this device last reported ready
let state = null;

// The clip. Volume and mute hold across rounds and reloads; iOS ignores a
// volume the page sets, so the slider stays hidden there.
const clip = $("clip");
const player = clip.closest(".player");
clipWave(clip, player.querySelector(".player-wave"));
const toggle = $("clip-toggle");
const volumeProbe = document.createElement("audio");
volumeProbe.volume = 0.5;
const canSetVolume = volumeProbe.volume !== 1;
const volumeKey = "earshot-volume";
const savedVolume = localStorage.getItem(volumeKey);
let clipVolume = savedVolume === null ? 0.6 : Number(savedVolume) / 100;
clip.removeAttribute("controls");
clip.removeAttribute("src");
clip.volume = clipVolume;
toggle.hidden = false;
{
  const input = $("clip-volume");
  if (input && canSetVolume) {
    input.hidden = false;
    input.value = String(Math.round(clipVolume * 100));
    input.oninput = () => {
      clipVolume = Number(input.value) / 100;
      clip.volume = clipVolume;
      localStorage.setItem(volumeKey, input.value);
    };
  }
  const muteKey = "earshot-muted";
  const mute = $("clip-volume-mute");
  const apply = (muted) => {
    clip.muted = muted;
    mute?.setAttribute("aria-pressed", String(muted));
  };
  apply(localStorage.getItem(muteKey) === "1");
  if (mute)
    mute.onclick = () => {
      const muted = mute.getAttribute("aria-pressed") !== "true";
      localStorage.setItem(muteKey, muted ? "1" : "0");
      apply(muted);
    };
}

// The icon follows the media element's real state. `hidden` is set as an
// attribute because the icons are SVG, where the property does not reflect.
const syncIcon = () => {
  const playing = !clip.paused && !clip.ended;
  toggle.querySelector(".i-play").toggleAttribute("hidden", playing);
  toggle.querySelector(".i-pause").toggleAttribute("hidden", !playing);
  if (playing) toggle.classList.remove("needs-click");
  document.body.classList.toggle("clip-live", playing);
};
["play", "playing", "pause", "ended"].forEach((event) =>
  clip.addEventListener(event, syncIcon),
);

// A clip never cuts off: it fades out before a pause and before its end.
// iOS ignores the volume, so there it stops at once.
let fading = 0;
function fadeOut(ms = 600) {
  if (clip.paused) return;
  const id = ++fading;
  if (!canSetVolume || reducedMotion) {
    clip.pause();
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    if (id !== fading) return;
    // A frame's timestamp can precede t0, which would push k below 0.
    const k = Math.min(1, Math.max(0, (t - t0) / ms));
    clip.volume = clipVolume * (1 - k);
    if (k < 1) requestAnimationFrame(step);
    else {
      clip.pause();
      clip.volume = clipVolume;
    }
  };
  requestAnimationFrame(step);
}
function playClip() {
  fading += 1;
  clip.volume = clipVolume;
  return clip.play();
}
clip.addEventListener("timeupdate", () => {
  if (clip.duration - clip.currentTime < 0.8 && !clip.paused) fadeOut(700);
});

// Browsers hold sound until the page gets a tap. The first tap anywhere
// plays the round's element muted for a moment (a silent file when it has
// no clip yet), which unlocks it for the rounds the socket starts later.
let unlocked = false;
let unlocking = false;
function unlock() {
  if (unlocked || unlocking) return;
  if (!clip.paused) {
    unlocked = true;
    renderSound();
    return;
  }
  unlocking = true;
  const hadClip = clip.getAttribute("src") !== null;
  const wasMuted = clip.muted;
  const round = openedRound;
  if (!hadClip) clip.src = "/silence.wav";
  clip.muted = true;
  const settle = () => {
    unlocking = false;
    clip.muted = wasMuted;
    if (!hadClip) {
      if (clip.dataset.url) clip.src = clip.dataset.url;
      else clip.removeAttribute("src");
    }
  };
  clip.play().then(() => {
    unlocked = true;
    // A round that opened meanwhile owns the clip now.
    if (openedRound === round) {
      clip.pause();
      if (hadClip) clip.currentTime = 0;
    }
    settle();
    renderSound();
  }, settle);
}
document.addEventListener("pointerdown", unlock, { capture: true });
document.addEventListener("keydown", unlock, { capture: true });

toggle.onclick = () => {
  if (clip.paused) {
    playClip().then(
      () => {
        unlocked = true;
        renderSound();
      },
      () => {},
    );
  } else fadeOut(250);
};

function renderSound() {
  show($("sound-check"), !unlocked);
}

function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`,
  );
  ws.onopen = () => {
    // Everyone is seated on arrival: the token finds a returning player or
    // the creator, a signed-in player sits under their profile name, and a
    // guest under the nickname they used last. Only a guest with no saved
    // nickname is asked for one.
    const token = localStorage.getItem(tokenKey) || undefined;
    const saved = signedIn ? "" : localStorage.getItem(nicknameKey) || "";
    typedJoin = false;
    send({ type: "join", token, name: saved || undefined });
  };
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = (event) => {
    if (event.code === 1001) closed();
    if (event.code === 4001) away();
    if (!gone) setTimeout(connect, 1000);
  };
}

function send(value) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(value));
}

// The closed panel: the room ended, or it is full and this device holds no
// seat. A full room offers its category solo.
function closed(full = false) {
  gone = true;
  error("");
  const preview = state;
  $("closed-title").textContent = full
    ? "This room is full"
    : "This room has closed";
  $("closed-text").textContent = full
    ? `All ${preview?.seats ?? 8} seats in ${preview?.category ? `${preview.category} · ` : ""}${code} are taken. You can play the same category on your own.`
    : "The game here is over. Start a new one from any category on the hub.";
  show($("closed-code"), !full);
  const seats = $("closed-seats");
  show(seats, full && !!preview);
  if (full && preview)
    monoStack(
      seats,
      preview.players.map((p) => (typeof p === "string" ? p : p.name)),
    );
  show($("closed-solo"), full && !!preview?.categorySlug);
  if (preview?.categorySlug) {
    $("closed-category").value = preview.categorySlug;
    $("closed-mode").value = preview.mode;
  }
  setPhase("closed");
  fadeOut();
}

// The seat moved to another device, which opened its link or signed in to
// the same account. This one stops reconnecting until it takes the seat
// back, which moves it here again.
function away() {
  gone = true;
  clearTimers();
  fadeOut();
  $("devices-sheet").close?.();
  setPhase("away");
}
$("take-back").onclick = () => {
  gone = false;
  setPhase("connecting");
  connect();
};

function handle(message) {
  if (message.type === "moved") {
    away();
    return;
  }
  if (message.type === "joined") {
    localStorage.setItem(tokenKey, message.token);
    if (typedJoin) localStorage.setItem(nicknameKey, message.name);
    return;
  }
  if (message.type === "preview") {
    state = message;
    fillRoom(message);
    fillJoin(message);
    return;
  }
  if (message.type === "error") {
    if (message.code === "gone") {
      closed();
      ws.close();
      return;
    }
    if (message.code === "full") {
      closed(true);
      ws.close();
      return;
    }
    setPhase("join");
    // The arrival join has no typed name, so "name" just means "ask".
    if (message.code === "name" && !typedJoin) {
      $("nickname").focus({ preventScroll: true });
      return;
    }
    error(
      {
        name: "Pick a nickname of 1 to 20 characters.",
        taken: typedJoin
          ? "That nickname is taken in this room."
          : `${localStorage.getItem(nicknameKey)} is taken in this room. Pick another.`,
      }[message.code] || "Something went wrong.",
    );
    return;
  }
  if (message.type === "state") render(message);
}

function error(text) {
  const box = $("room-error");
  box.textContent = text;
  show(box, text !== "");
}

// The page shows one view: join, lobby, round, done, closed or away. CSS
// keys the bar and header off it.
function setPhase(view) {
  root.dataset.phase = view;
  show($("join-panel"), view === "join");
  show($("lobby-panel"), view === "lobby");
  show($("round"), view === "round");
  show($("done-panel"), view === "done");
  show($("closed-panel"), view === "closed");
  show($("away-panel"), view === "away");
}

// What every panel shows of the room itself: its category, mosaic and mode.
function fillRoom(s) {
  root.querySelectorAll("[data-room='category']").forEach((node) => {
    node.textContent = s.category;
  });
  root.querySelectorAll(".mosaic").forEach((node) => {
    node.style.setProperty("--hue", String(hueOf(s.categorySlug || "")));
  });
  root.querySelectorAll(".room-mode").forEach((node) => {
    node.textContent = modeNames[s.mode] ?? "";
    node.classList.toggle("is-hard", s.mode === "hard");
  });
}

function fillJoin(s) {
  $("join-mode").textContent = `${modeLabels[s.mode]} · ${s.rounds} rounds`;
  const people = s.players.map((p) => (typeof p === "string" ? p : p.name));
  const who = $("join-who");
  show(who, people.length > 0);
  monoStack(who.querySelector(".mono-stack"), people.slice(0, 4));
  who.querySelector(".room-who-text").textContent =
    `${names(people.length > 3 ? [...people.slice(0, 2), `${people.length - 2} more`] : people)} ${people.length === 1 ? "is" : "are"} in · ${people.length} of ${s.seats}`;
}

function render(s) {
  state = s;
  offset = s.now - Date.now();
  fillRoom(s);
  if (!s.you.name) return; // not seated yet; the join answer decides
  error("");
  $("room-name").textContent = `${s.category} · Room ${s.code}`;
  for (const button of document.querySelectorAll("[data-devices]"))
    button.toggleAttribute("data-tv", Boolean(s.screen));
  const view =
    s.phase === "lobby" ? "lobby" : s.phase === "done" ? "done" : "round";
  // The last song plays on under the final standings.
  if (view !== "round") clearTimers();
  if (view === "lobby") fadeOut();
  // A finished game opens on its results, not on the step left open last.
  if (view !== "done") delete $("done-panel").dataset.step;
  setPhase(view);
  renderBar(s);
  if (view === "lobby") renderLobby(s);
  if (s.phase === "loading" || s.phase === "playing") renderQuestion(s);
  if (s.phase === "reveal") renderReveal(s);
  if (view === "done") renderDone(s);
}

function clearTimers() {
  clearInterval(tickTimer);
  clearTimeout(playTimer);
}

const host = (s) => s.players.find((p) => p.creator)?.name;
const me = (s) => s.players.find((p) => p.name === s.you.name);

// Segments fill with your right and wrong answers; the current round is
// the accent one. On the reveal the round's segment is the countdown to the
// next round: it fills in your verdict's colour until the room moves on.
function renderBar(s) {
  const marks = s.you.marks ?? [];
  const live = s.phase === "loading" || s.phase === "playing";
  const current = live ? (s.round ?? 1) - 1 : -1;
  const revealed = s.phase === "reveal" ? s.reveal.number - 1 : -1;
  root.querySelectorAll(".game-progress .seg").forEach((seg, i) => {
    if (i === revealed) {
      const mine = s.reveal.results.find((r) => r.name === s.you.name);
      const verdict = mine?.correct ? "right" : "wrong";
      // Restarting the fill on every state message would make it jump.
      if (seg.dataset.reveal === verdict) return;
      seg.className = "seg";
      seg.dataset.reveal = verdict;
      const ms = Math.max(0, s.reveal.until - offset - Date.now());
      seg.style.setProperty("--next-ms", `${ms}ms`);
      return;
    }
    delete seg.dataset.reveal;
    seg.className = "seg";
    if (i < marks.length)
      seg.classList.add("is-done", marks[i] ? "is-right" : "is-wrong");
    if (i === current) seg.classList.add("is-current");
  });
  const round = Math.max(1, Math.min(s.round ?? marks.length, s.rounds));
  const progress = root.querySelector(".game-progress");
  progress.setAttribute("aria-valuenow", String(round));
  progress.setAttribute("aria-label", `Round ${round} of ${s.rounds}`);
  root.querySelector(".game-score-n").textContent = number(me(s)?.score ?? 0);
}

const tag = (text, kind) => el("span", `room-tag is-${kind}`, text);

// A person in the lobby: monogram, name, signed in or guest, and the tags.
function personRow(p, s) {
  const li = el("li", p.name === s.you.name ? "is-you" : "");
  if (!p.connected) li.dataset.away = "";
  const who = el("span", "room-person");
  who.append(
    el("b", "", p.name),
    el("small", "", p.user ? "Signed in" : "Guest"),
  );
  const tags = el("span", "room-tags");
  if (p.name === s.you.name) tags.append(tag("You", "you"));
  if (p.creator) tags.append(tag("Host", "host"));
  if (!p.connected) tags.append(tag("Away", "away"));
  li.append(mono(p.name), who, tags);
  return li;
}

// The open seats: dashed circles and a count on a phone, a box per seat
// from 900px.
function seatsRow(s) {
  const open = s.seats - s.players.length;
  const li = el("li", "room-seats");
  if (open <= 0) return null;
  const boxes = el("span", "room-seat-list");
  boxes.setAttribute("aria-hidden", "true");
  for (let i = s.players.length + 1; i <= s.seats; i += 1)
    boxes.append(el("span", "room-seat", `Seat ${i}`));
  li.append(
    boxes,
    el(
      "span",
      "room-seat-count",
      `${open} ${open === 1 ? "seat" : "seats"} open`,
    ),
  );
  return li;
}

function waitRow(box, text, name) {
  box.replaceChildren();
  if (name) box.append(mono(name, 36));
  const words = el("span", "room-wait-text");
  words.append(text);
  const dots = el("span", "room-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(el("i"), el("i"), el("i"));
  box.append(words, dots);
}

function hostText(s, what) {
  const name = host(s);
  const span = document.createDocumentFragment();
  span.append("Waiting for ");
  span.append(el("strong", "", name ?? "the host"));
  span.append(` to ${what}.`);
  return span;
}

const kindOf = (slug) => (slug.startsWith("artist-") ? "Artist" : "Genre");

// "3 suggestions · 2 of 4 voted". A player holds one vote, so the votes
// are the voters.
function suggestionCount(s) {
  const list = s.suggestions ?? [];
  if (list.length === 0) return "No suggestions yet";
  const voters = list.reduce((sum, x) => sum + x.votes, 0);
  const n = `${list.length} ${list.length === 1 ? "suggestion" : "suggestions"}`;
  return `${n} · ${voters} of ${s.players.length} voted`;
}

// The Next game step lists the suggestions, most votes first. Returns the
// top one when it holds a vote, which the host's main button plays.
function renderUpNext(s) {
  const list = s.suggestions ?? [];
  const top = list[0]?.votes > 0 ? list[0] : undefined;
  $("up-next-live").textContent = suggestionCount(s);
  show($("up-next-empty"), list.length === 0);
  $("up-next-list").replaceChildren(
    ...list.map((x) => {
      const li = el("li", "room-sug");
      if (x === top) li.dataset.top = "";
      const text = el("span", "room-sug-text");
      text.append(
        el("b", "", x.name),
        el(
          "small",
          "",
          `${kindOf(x.slug)} · ${modeNames[x.mode]}${x.by ? ` · ${x.mine ? "you" : x.by}` : ""}`,
        ),
      );
      const vote = el("button", "btn-vote", `▲ ${x.votes}`);
      vote.type = "button";
      vote.setAttribute("aria-pressed", String(x.voted));
      vote.setAttribute(
        "aria-label",
        `Vote for ${x.name}, ${x.votes} ${x.votes === 1 ? "vote" : "votes"}`,
      );
      vote.onclick = () => send({ type: "vote", id: x.id });
      li.append(el("span", "room-sug-tile", [...x.name][0] ?? "?"), text, vote);
      if (s.you.creator) {
        const play = el("button", "btn-play-this", "Play this");
        play.type = "button";
        play.onclick = () => switchTo(x.slug, x.mode, true);
        li.append(play);
      }
      return li;
    }),
  );
  // A player's own suggestion sits in its card; picking again replaces it.
  const mine = list.find((x) => x.mine);
  show($("mine-card"), mine !== undefined && !s.you.creator);
  show($("mine-add"), mine === undefined || s.you.creator);
  if (mine) $("mine-name").textContent = mine.name;
  return top;
}

// The Next game step is a view inside the results, so the room's state
// keeps rendering into it while it is open.
function openNext(open, focus = true) {
  $("done-panel").dataset.step = open ? "next" : "results";
  show($("next-panel"), open);
  if (focus) (open ? $("next-title") : $("next-open")).focus();
}
$("next-open").onclick = () => openNext(true);
$("next-back").onclick = () => openNext(false);
$("mine-change").onclick = () => {
  const mine = state?.suggestions?.find((x) => x.mine);
  openPicker("suggest", mine?.slug.startsWith("artist-") ? "artist" : "genre");
};

// The host's pick goes through the same switch the hub posts; with start,
// the next game begins without a stop in the lobby.
function switchTo(slug, mode, start) {
  const body = new FormData();
  body.set("category", slug);
  body.set("mode", mode);
  body.set("k", localStorage.getItem(tokenKey) || "");
  if (start) body.set("start", "1");
  error("");
  return fetch(`/play/room/${code}/switch`, { method: "POST", body })
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
    })
    .catch(() =>
      error("That pick did not load. Try it again or pick another."),
    );
}

// The pick sheet. A player suggests; the host plays the pick after a game
// or sets it in the lobby. Artist search runs as you type: 250 ms after the
// last key, and a newer query aborts the older request.
const picker = {
  purpose: "suggest",
  tab: "genre",
  choice: null,
  mode: "normal",
  genres: null,
  artists: [],
  query: "",
  timer: 0,
  abort: null,
};
const pickTitles = {
  suggest: "Suggest next game",
  next: "Pick next game",
  set: "Change category",
};

function openPicker(purpose, tab) {
  picker.purpose = purpose;
  picker.choice = null;
  picker.mode = state?.mode ?? "normal";
  $("pick-title").textContent = pickTitles[purpose];
  setPickTab(tab);
  $("pick-sheet").showModal();
  if (tab === "artist") $("pick-q").focus();
}

function setPickTab(tab) {
  picker.tab = tab;
  picker.choice = null;
  for (const button of document.querySelectorAll(".pick-tabs [data-tab]"))
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
  show($("pick-search"), tab === "artist");
  if (tab === "genre" && picker.genres === null) loadGenres();
  renderPickList();
}

function loadGenres() {
  picker.genres = [];
  $("pick-status").textContent = "Loading genres…";
  fetch("/play/picks")
    .then((response) => (response.ok ? response.json() : Promise.reject()))
    .then((body) => {
      picker.genres = body.genres ?? [];
      $("pick-status").textContent = "";
    })
    .catch(() => {
      picker.genres = null;
      $("pick-status").textContent =
        "Genres did not load. Close and try again.";
    })
    .finally(renderPickList);
}

function searchArtists() {
  const query = $("pick-q").value.trim();
  picker.query = query;
  picker.abort?.abort();
  clearTimeout(picker.timer);
  if (query === "") {
    picker.artists = [];
    $("pick-status").textContent = "";
    return renderPickList();
  }
  picker.timer = setTimeout(() => {
    const abort = new AbortController();
    picker.abort = abort;
    $("pick-status").textContent = "Searching…";
    fetch(`/play/picks?q=${encodeURIComponent(query)}`, {
      signal: abort.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body) => {
        picker.artists = body.artists ?? [];
        $("pick-status").textContent = picker.artists.length
          ? ""
          : `No artist matches “${query}”.`;
        renderPickList();
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        picker.artists = [];
        $("pick-status").textContent =
          "Artist search is not answering. Try a genre, or search again.";
        renderPickList();
      });
  }, 250);
}

function pickRow(item, top) {
  const button = el("button", top ? "pick-hit is-top" : "pick-hit");
  button.type = "button";
  button.setAttribute(
    "aria-pressed",
    String(picker.choice?.slug === item.slug),
  );
  if (item.picture) {
    const img = el("img", "pick-art");
    img.src = item.picture;
    img.alt = "";
    img.loading = "lazy";
    button.append(img);
  } else {
    button.append(el("span", "pick-art", [...item.name][0] ?? "?"));
  }
  const text = el("span", "pick-text");
  if (top) text.append(el("small", "pick-kicker", "Top hit"));
  text.append(el("b", "", item.name));
  if (item.fans !== undefined)
    text.append(el("small", "", `${number(item.fans)} fans`));
  button.append(text);
  button.onclick = () => {
    picker.choice = { slug: item.slug, name: item.name };
    renderPickList();
  };
  const li = el("li");
  li.append(button);
  return li;
}

function renderPickList() {
  const items =
    picker.tab === "genre"
      ? (picker.genres ?? []).filter((g) => g.slug !== state?.categorySlug)
      : picker.artists;
  $("pick-list").replaceChildren(
    ...items.map((item, i) =>
      pickRow(item, picker.tab === "artist" && i === 0),
    ),
  );
  for (const button of document.querySelectorAll(".pick-modes [data-mode]"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.mode === picker.mode),
    );
  const go = $("pick-go");
  const choice = picker.choice;
  go.disabled = choice === null;
  go.textContent =
    choice === null
      ? picker.tab === "artist"
        ? "Search and pick an artist"
        : "Pick a genre"
      : picker.purpose === "suggest"
        ? `Suggest ${choice.name} · ${modeNames[picker.mode]}`
        : picker.purpose === "next"
          ? `Play ${choice.name} · ${modeNames[picker.mode]}`
          : `Set ${choice.name} · ${modeNames[picker.mode]}`;
}

function wirePicker() {
  const sheet = $("pick-sheet");
  for (const button of document.querySelectorAll("[data-pick]"))
    button.onclick = () =>
      openPicker(state?.you.creator ? "next" : "suggest", button.dataset.pick);
  $("change-category").onclick = () => openPicker("set", "genre");
  for (const button of document.querySelectorAll(".pick-tabs [data-tab]"))
    button.onclick = () => {
      setPickTab(button.dataset.tab);
      if (button.dataset.tab === "artist") $("pick-q").focus();
    };
  for (const button of document.querySelectorAll(".pick-modes [data-mode]"))
    button.onclick = () => {
      picker.mode = button.dataset.mode;
      renderPickList();
    };
  $("pick-q").oninput = searchArtists;
  // Enter takes the top hit, so a typed name and Enter is enough.
  $("pick-q").onkeydown = (event) => {
    if (event.key !== "Enter" || picker.artists.length === 0) return;
    event.preventDefault();
    const [first] = picker.artists;
    picker.choice = { slug: first.slug, name: first.name };
    renderPickList();
    $("pick-go").focus();
  };
  $("pick-close").onclick = () => sheet.close();
  // A tap on the backdrop lands on the dialog itself.
  sheet.onclick = (event) => {
    if (event.target === sheet) sheet.close();
  };
  $("pick-go").onclick = () => {
    const choice = picker.choice;
    if (choice === null) return;
    if (picker.purpose === "suggest")
      send({ type: "suggest", category: choice.slug, mode: picker.mode });
    else switchTo(choice.slug, picker.mode, picker.purpose === "next");
    sheet.close();
  };
  $("pick-hub").href = `/?room=${code}`;
}

function renderLobby(s) {
  shownRound = 0;
  $("lobby-mode").textContent = modeLabels[s.mode];
  $("players-count").textContent = `${s.players.length} of ${s.seats}`;
  const rows = s.players.map((p) => personRow(p, s));
  const seats = seatsRow(s);
  $("lobby-players").replaceChildren(...rows, ...(seats ? [seats] : []));
  const creator = s.you.creator;
  show($("start-button"), creator);
  show($("change-category"), creator);
  const wait = $("lobby-wait");
  if (s.kind === "match")
    waitRow(wait, "The game starts once everyone is connected.");
  else waitRow(wait, hostText(s, "start the game"), host(s));
  show(wait, !creator);
  renderSound();
}

// A new round resets the stage: the now-playing card goes, the ring comes
// back, and four skeleton choices hold the answers' place until the clip
// starts, so nothing moves when they fill.
function setUpRound(s) {
  shownRound = s.round;
  openedRound = 0;
  revealedRound = 0;
  answered = false;
  clearTimers();
  player.querySelector(".player-round").textContent =
    `Round ${s.round} of ${s.rounds}`;
  player.classList.remove("is-reveal");
  player.querySelector(".now")?.remove();
  show($("typed-verdict"), false);
  $("room-slot").removeAttribute("data-v");
  $("slot-title").textContent = "Answered";
  $("slot-note").textContent =
    "The round ends early once everyone has answered.";
  $("round").dataset.phase = "question";
  const box = $("choices");
  box.className = "choices";
  box.replaceChildren(
    ...(s.mode === "hard"
      ? []
      : Array.from({ length: 4 }, (_, index) => {
          const button = el("button", "choice is-skeleton");
          button.type = "button";
          button.disabled = true;
          const key = el("span", "choice-key", String(index + 1));
          key.setAttribute("aria-hidden", "true");
          button.append(key, choiceLabel({ title: "…", artist: "…" }));
          return button;
        })),
  );
  show($("typed-form"), false);
  $("count-left").textContent = "15";
  $("count-worth").textContent = "1000";
  $("count-bar").style.setProperty("--left", "1");
}

// Before the clip starts the ring holds the round number and what to do:
// "Round 7 of 10 · Get ready". From 900px it reads large inside the ring; a
// phone keeps "7 of 10" in the ring and puts the words beside it, in the
// stage's heading.
function setWaiting(text, s) {
  player.classList.toggle("is-loading", text !== null);
  const ask = player.querySelector(".player-ask");
  player.querySelector(".player-sub")?.remove();
  if (text === null) {
    ask.textContent = "Which song is this?";
    return;
  }
  ask.after(
    el(
      "p",
      "player-sub",
      s.screen
        ? "The clip plays on the TV."
        : "The clip starts on every phone at once.",
    ),
  );
  const ring = player.querySelector(".player-loading");
  const number = el("b", "r-num");
  number.append(el("span", "r-word", "Round "), String(s.round));
  ring.replaceChildren(
    el("small", "r-kick", "Round"),
    number,
    el("span", "r-of", `of ${s.rounds}`),
    el("span", "r-go", text),
  );
  ask.textContent = text;
}

function renderQuestion(s) {
  if (s.round !== shownRound || $("round").dataset.phase !== "question")
    setUpRound(s);
  renderChips(s);
  if (s.phase === "loading" || !s.endsAt) {
    setWaiting("Get ready", s);
    return;
  }
  // The clip goes to every phone at once; on a screened room it plays on
  // the TV and phones only answer.
  if (s.screen) {
    if (clip.dataset.url !== undefined) {
      clip.pause();
      clip.removeAttribute("src");
      delete clip.dataset.url;
    }
  } else if (s.clip && clip.dataset.url !== s.clip) {
    clip.dataset.url = s.clip;
    clip.src = s.clip;
  }
  // Each device tells the room when its clip can play; the round starts on
  // the last report or the server's timeout.
  if (s.round !== loadedFor) {
    loadedFor = s.round;
    if (s.screen || !s.clip) send({ type: "loaded" });
    else if (clip.readyState >= 3) send({ type: "loaded" });
    else
      clip.addEventListener("canplay", () => send({ type: "loaded" }), {
        once: true,
      });
  }
  answered = answered || s.you.answer !== null;
  const delay = s.startedAt - offset - Date.now();
  clearTimeout(playTimer);
  if (openedRound === s.round) return;
  if (delay > 0) {
    setWaiting(s.screen ? "Watch the TV" : "Get ready", s);
    playTimer = setTimeout(() => openRound(s), delay);
  } else openRound(s);
}

// The server's round start: the clip plays, the answers open and the clock
// runs. Answers stay hidden until then; anything earlier is a blind guess.
function openRound(s) {
  openedRound = s.round;
  setWaiting(null);
  if (!s.screen && s.clip) {
    const elapsed = (Date.now() + offset - s.startedAt) / 1000;
    if (elapsed > 0.5 && clip.readyState >= 1) clip.currentTime = elapsed;
    playClip().catch(() => toggle.classList.add("needs-click"));
  }
  if (s.mode === "hard") {
    show($("typed-form"), !answered);
    if (!answered) $("typed-answer").focus({ preventScroll: true });
  } else fillChoices(s);
  const tick = () => {
    const left = Math.max(0, s.endsAt - offset - Date.now());
    $("count-left").textContent = String(Math.ceil(left / 1000));
    $("count-worth").textContent = String(worthAt(left));
    $("count-bar").style.setProperty("--left", String(left / roundMs));
    if (left <= 0) clearInterval(tickTimer);
  };
  tick();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, tickMs);
}

function lock(button) {
  button.classList.add("is-picked");
  if (!button.querySelector(".choice-lock"))
    button.append(el("span", "choice-lock", "Locked in"));
}

function fillChoices(s) {
  const box = $("choices");
  const buttons = box.querySelectorAll(".choice");
  (s.choices ?? []).forEach((choice, index) => {
    const button = buttons[index];
    if (!button) return;
    button.classList.remove("is-skeleton");
    button.querySelector(".choice-label").replaceWith(choiceLabel(choice));
    button.dataset.title = choice.title;
    button.disabled = answered;
    if (choice.title === s.you.answer) lock(button);
    button.onclick = () => pick(button);
  });
  box.classList.toggle("is-locked", answered);
}

// A pick locks in at once: the button keeps its place with a "Locked in"
// tag and the rest go quiet until the reveal.
function pick(button) {
  if (answered) return;
  answered = true;
  send({ type: "answer", answer: button.dataset.title });
  lock(button);
  const box = $("choices");
  box.classList.add("is-locked");
  box.querySelectorAll(".choice").forEach((b) => {
    b.disabled = true;
  });
}

// The round's card: a chip per player that keeps its cell from the question
// to the reveal. During the round it says who has answered, never what;
// at the reveal it shows what each player scored.
function chip(p, s, state, line) {
  const li = el("li", "room-chip");
  li.dataset.s = state;
  if (p.name === s.you.name) li.classList.add("is-you");
  const text = el("span", "c-text");
  text.append(
    el("b", "", p.name === s.you.name ? "You" : p.name),
    el("small", "c-pts", line),
  );
  li.append(mono(p.name), text);
  return li;
}

function renderChips(s) {
  const done = s.players.filter((p) => p.answered).length;
  $("answered-count").textContent = `${done} of ${s.players.length}`;
  $("round-chips").replaceChildren(
    ...s.players.map((p) =>
      p.answered
        ? chip(p, s, "answered", "Answered")
        : chip(p, s, "waiting", "Thinking…"),
    ),
  );
}

function renderResults(s, r) {
  const results = new Map(r.results.map((result) => [result.name, result]));
  const got = r.results.filter((result) => result.correct).length;
  $("slot-title").textContent = "This round";
  $("answered-count").textContent = `${got} of ${s.players.length} got it`;
  $("round-chips").replaceChildren(
    ...s.players.map((p) => {
      const result = results.get(p.name);
      if (result?.correct) return chip(p, s, "right", `+${result.score}`);
      if (result?.answer) return chip(p, s, "wrong", "× +0");
      return chip(p, s, "none", "— +0");
    }),
  );
}

// "Nailed it! +782 · 2nd of 4 overall": the verdict heads the round's card.
function fillVerdict(s, r, mine) {
  const verdict = mine?.correct ? "right" : mine?.answer ? "wrong" : "late";
  $("room-slot").dataset.v = verdict;
  $("verdict-word").textContent = {
    right: "Nailed it!",
    wrong: "Not quite",
    late: "Time ran out",
  }[verdict];
  const points = $("verdict-points");
  const score = mine?.score ?? 0;
  points.textContent = `+${score}`;
  if (score > 0 && !reducedMotion) {
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 500);
      points.textContent = `+${Math.round(score * k)}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const ranked = [...s.players].sort((a, b) => b.score - a.score);
  const place = 1 + ranked.filter((p) => p.score > (me(s)?.score ?? 0)).length;
  $("verdict-place").textContent =
    s.players.length > 1
      ? `${ordinal(place)} of ${s.players.length} overall`
      : "";
  // A right answer's score falls with time, so the order of the right
  // answers' scores is the order they came in.
  const right = r.results.filter((result) => result.correct);
  const speed =
    mine?.correct && right.length > 1
      ? 1 + right.filter((result) => result.score > mine.score).length
      : 0;
  const fastest =
    speed === 1
      ? "You were the fastest. "
      : speed > 1
        ? `You were ${ordinal(speed)} fastest. `
        : "";
  const next = r.number >= s.rounds ? "The results come" : "Next round";
  $("slot-note").textContent = `${fastest}${next} when the bar above fills.`;
}

function renderReveal(s) {
  const r = s.reveal;
  if (r.number !== shownRound) setUpRound({ ...s, round: r.number });
  const round = $("round");
  const mine = r.results.find((result) => result.name === s.you.name);
  if (revealedRound !== r.number) {
    revealedRound = r.number;
    clearInterval(tickTimer);
    clearTimeout(playTimer);
    setWaiting(null);
    round.dataset.phase = "reveal";
    morphChoices(s, r, mine);
    fillNow(s, r);
    if (mine?.correct && "vibrate" in navigator) navigator.vibrate(25);
  }
  fillVerdict(s, r, mine);
  renderResults(s, r);
}

function morphChoices(s, r, mine) {
  const box = $("choices");
  if (s.mode === "hard") {
    show($("typed-form"), false);
    const given = $("typed-given");
    given.textContent = mine?.answer || "Nothing";
    given.className = mine?.correct ? "good" : "";
    show($("typed-verdict"), true);
    return;
  }
  box.className = "choices reveal-choices";
  const buttons = box.querySelectorAll(".choice");
  r.choices.forEach((choice, index) => {
    const button = buttons[index];
    if (!button) return;
    const right = choice.title === r.title;
    const yours = choice.title === mine?.answer;
    button.className = `choice${right ? " is-right" : yours ? " is-wrong" : ""}`;
    button.disabled = true;
    button.onclick = null;
    const mark = right
      ? fromTemplate("check-template")
      : yours
        ? fromTemplate("cross-template")
        : el("span", "choice-key", String(index + 1));
    if (!right && !yours) mark.setAttribute("aria-hidden", "true");
    button.replaceChildren(mark, choiceLabel(choice));
    if (yours) {
      const you = el("span", "choice-you", "You");
      you.append(el("span", "is-wide", "r pick"));
      button.append(you);
    }
    if (right && mine?.correct && !reducedMotion) {
      const burst = el("span", "burst");
      burst.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 8; i += 1) burst.append(el("i"));
      button.append(burst);
    }
  });
}

// The stage turns into the now-playing card with the clip still running.
function fillNow(s, r) {
  const now = fromTemplate("now-template");
  const cover = now.querySelector(".now-cover");
  if (r.cover) {
    const img = el("img");
    img.src = r.cover;
    img.alt = "";
    img.width = 320;
    img.height = 320;
    cover.append(img);
  }
  now.querySelector(".now-title").textContent = r.title;
  now.querySelector(".now-by").textContent = byline(r);
  const link = now.querySelector(".now-link");
  if (r.link) {
    link.href = r.link;
    const service = [...link.childNodes].find((n) => n.nodeType === 3);
    if (service) service.textContent = linkService(r.link);
  } else link.remove();
  const report = now.querySelector(".report");
  if (r.track) {
    const form = report.querySelector("form");
    form.elements.track.value = r.track;
    form.elements.title.value = r.title;
    form.elements.artist.value = r.artist;
    form.elements.category.value = s.categorySlug || "";
    form.elements.back.value = location.pathname;
  } else report.remove();
  player.querySelector(".now")?.remove();
  player.append(now);
  player.classList.add("is-reveal");
}

// The final screen: your score and place, the standings (people), the
// rounds (songs, with who got each one) and the category's board. Neither
// list repeats the other.
function renderDone(s) {
  shownRound = 0;
  const marks = s.you.marks ?? [];
  const standings = s.standings ?? [];
  const mineScore = me(s)?.score ?? 0;
  const place = 1 + standings.filter((p) => p.score > mineScore).length;
  const many = standings.length > 1;
  const winner = standings[0];
  const tied = many && standings[1].score === winner.score;
  $("score-n").textContent = number(mineScore);
  $("score-rank").textContent = !many
    ? s.category
    : tied
      ? `Tied for first with ${number(winner.score)}`
      : winner.name === s.you.name
        ? `You won with ${number(winner.score)}`
        : `${winner.name} won with ${number(winner.score)}`;
  $("score-best").textContent = `${ordinal(place)} of ${standings.length}`;
  show($("score-best"), many);
  $("score-pips").setAttribute(
    "aria-label",
    `${marks.filter(Boolean).length} of ${marks.length} right`,
  );
  $("score-pips").replaceChildren(
    ...marks.map((right) => el("li", right ? "is-right" : "")),
  );
  let best = 0;
  let run = 0;
  for (const right of marks) {
    run = right ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const stats = [
    ["Correct", `${marks.filter(Boolean).length}/${marks.length}`],
    ["Best streak", String(best)],
    ["Place", many ? ordinal(place) : "—"],
  ];
  $("done-stats").replaceChildren(
    ...stats.map(([label, value]) => {
      const div = el("div");
      div.append(el("dt", "", label), el("dd", "", value));
      return div;
    }),
  );
  const creator = s.you.creator;
  const top = renderUpNext(s);
  // The results offer the same game again or the step that picks another;
  // a guest sees the host's choice coming.
  show($("rematch-button"), creator);
  show($("next-rematch"), creator);
  $("rematch-sub").textContent = `${s.category} · ${modeNames[s.mode]}`;
  $("next-open-sub").textContent = suggestionCount(s);
  $("next-sub").textContent = creator
    ? "Everyone suggests and votes. You play the pick."
    : "Suggest a genre or an artist, and vote. The host plays the pick.";
  show($("play-top"), creator && top !== undefined);
  if (top) $("play-top").firstChild.textContent = `Play ${top.name} `;
  for (const id of ["done-wait", "next-wait"]) {
    show($(id), !creator);
    waitRow($(id), hostText(s, "pick the next game"), host(s));
  }
  if (!$("done-panel").dataset.step) openNext(false, false);

  const creators = new Set(
    s.players.filter((p) => p.creator).map((p) => p.name),
  );
  $("done-standings").replaceChildren(
    ...standings.map((p) => {
      const li = el("li", p.name === s.you.name ? "is-you" : "");
      const rank = 1 + standings.filter((q) => q.score > p.score).length;
      const who = el("span", "room-person");
      const line = el("b", "", p.name);
      if (p.name === s.you.name) line.append(tag("You", "you"));
      if (creators.has(p.name)) line.append(tag("Host", "host"));
      who.append(
        line,
        el("small", "", `${p.correct ?? 0}/${s.rounds} correct`),
      );
      li.append(
        el("span", "board-rank", String(rank)),
        mono(p.name),
        who,
        el("span", "board-score", number(p.score)),
      );
      return li;
    }),
  );

  $("done-rounds").replaceChildren(
    ...(s.history ?? []).map((h) => {
      const li = el("li");
      const i = el("span", "round-i", String(h.number));
      i.setAttribute("aria-hidden", "true");
      const cover = el("span", "cover-tile");
      cover.style.setProperty("--hue", String(hueOf(h.title)));
      if (h.cover) {
        const img = el("img");
        img.src = h.cover;
        img.alt = "";
        img.width = 52;
        img.height = 52;
        img.loading = "lazy";
        cover.append(img);
      }
      const yours = h.results.find((result) => result.name === s.you.name);
      const got = h.results.filter((result) => result.correct);
      const song = el("span", "round-song");
      const by = el("small", "", byline(h));
      if (!yours?.correct)
        by.append(
          " · ",
          el(
            "span",
            "round-said",
            yours?.answer ? `you said ${yours.answer}` : "no answer",
          ),
        );
      song.append(el("b", "", h.title), by);
      li.append(i, cover, song);
      if (many) {
        const who = el("span", "round-who");
        const stack = el("span", "mono-stack");
        monoStack(
          stack,
          got.map((g) => g.name),
        );
        const text =
          got.length === 0
            ? "nobody got it"
            : got.length === h.results.length
              ? "everyone got it"
              : `${got.map((g) => (g.name === s.you.name ? "you" : g.name)).join(", ")} got it`;
        who.append(stack, el("span", "", text));
        li.append(who);
      }
      const points = el(
        "span",
        `round-points ${yours?.correct ? "is-right" : "is-wrong"}`,
      );
      if (yours?.correct) points.textContent = `+${yours.score}`;
      else points.append(fromTemplate("cross-template"));
      li.append(points);
      return li;
    }),
  );

  // A guest who did well is offered the account that keeps the game; the
  // server moves this seat into it when the page comes back signed in.
  const boardRank =
    1 + (s.board ?? []).filter((entry) => entry.score > mineScore).length;
  const won = many && !tied && winner.name === s.you.name;
  const save = $("done-save");
  save.querySelector("[data-save-title]").textContent = won
    ? `You beat the room. Keep the win`
    : boardRank <= 10
      ? `That's #${boardRank} on ${s.category}`
      : `Keep your ${number(mineScore)} points`;
  show(save, !s.you.user && mineScore > 0);

  const board = (s.board ?? []).slice(0, 5);
  const note = $("done-board-note");
  note.textContent = `${s.category} · last ${note.dataset.days} days`;
  show($("done-board-card"), board.length > 0 || !s.you.user);
  show($("done-board"), board.length > 0);
  show($("done-board-foot"), !s.you.user);
  $("done-board").replaceChildren(
    ...board.map((entry, index) => {
      const li = el(
        "li",
        s.you.user && entry.name === s.you.name ? "is-you" : "",
      );
      const name = el("span", "board-name");
      const link = el("a", "", entry.name);
      link.href = `/u/${encodeURIComponent(entry.name)}`;
      name.append(link);
      li.append(
        el("span", "board-rank", String(index + 1)),
        mono(entry.name, 32),
        name,
        el("span", "board-score", number(entry.score)),
      );
      return li;
    }),
  );
}

$("join-form").onsubmit = (event) => {
  event.preventDefault();
  typedJoin = true;
  send({
    type: "join",
    name: $("nickname").value,
    token: localStorage.getItem(tokenKey) || undefined,
  });
};
$("nickname").oninput = () => {
  $("nickname-count").textContent = `${[...$("nickname").value].length}/20`;
};
$("start-button").onclick = () => send({ type: "start" });
$("rematch-button").onclick = () => send({ type: "start" });
$("next-rematch").onclick = () => send({ type: "start" });
$("play-top").onclick = () => {
  const top = state?.suggestions?.[0];
  if (top) switchTo(top.slug, top.mode, true);
};
wirePicker();
$("sound-on").onclick = () => unlock();
$("typed-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $("typed-answer");
  if (!input.value.trim() || answered) return;
  answered = true;
  send({ type: "answer", answer: input.value });
  input.value = "";
  show($("typed-form"), false);
};

// Copy a link field's value; where the clipboard is refused, select it.
function copyFrom(button, input) {
  const label = button.querySelector("span");
  const done = () => {
    label.textContent = "Copied";
    setTimeout(() => {
      label.textContent = "Copy";
    }, 2000);
  };
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(input.value).then(done, () => input.select());
  else input.select();
}
$("copy-link").onclick = () => copyFrom($("copy-link"), $("room-link"));
for (const button of document.querySelectorAll("[data-copy]"))
  button.onclick = () => copyFrom(button, $(button.dataset.copy));
for (const input of document.querySelectorAll(".room-link"))
  input.onfocus = (event) => event.target.select();

// The Devices sheet. The seat link carries this device's key; the QR code
// comes from the server, which never stores it.
const devices = $("devices-sheet");
for (const button of document.querySelectorAll("[data-devices]"))
  button.onclick = () => {
    const key = localStorage.getItem(tokenKey) || "";
    const seat = new URL(`/play/room/${code}`, location.origin);
    seat.searchParams.set("k", key);
    $("seat-link").value = seat.href;
    $("seat-qr").src =
      `/play/room/${code}/seat.svg?k=${encodeURIComponent(key)}`;
    $("tv-link").value = new URL(
      `/play/room/${code}/screen`,
      location.origin,
    ).href;
    devices.showModal();
  };
$("devices-close").onclick = () => devices.close();
devices.onclick = (event) => {
  if (event.target === devices) devices.close();
};
if (navigator.share) {
  show($("share-link"), true);
  $("share-link").onclick = () =>
    navigator
      .share({ title: "Earshot", text: "Join my Earshot room", url: roomUrl })
      .catch(() => {});
}

// Reports go over fetch so the room socket stays connected.
document.addEventListener("submit", (event) => {
  const form = event.target.closest?.(".report-form");
  if (!form) return;
  event.preventDefault();
  const details = form.closest("details");
  fetch(form.action, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams(new FormData(form)),
  })
    .then((response) => {
      if (response.type === "opaqueredirect" || response.ok) {
        form.reset();
        if (details) details.open = false;
        return;
      }
      return Promise.reject(response.status);
    })
    .catch(() => {
      const hint = el(
        "small",
        "muted report-failed",
        "Could not send the report.",
      );
      form.querySelector(".report-failed")?.remove();
      form.append(hint);
    });
});

// Keyboard: 1-4 answers while the choices are open, Space plays or pauses,
// and Enter starts the game or the rematch for the host.
document.addEventListener("keydown", (event) => {
  if (event.repeat || document.querySelector("dialog[open]")) return;
  if (event.target.closest?.("input, textarea, select")) return;
  const phase = root.dataset.phase;
  if (event.key === "Enter" && !event.target.closest?.("button, a, summary")) {
    const button =
      phase === "lobby"
        ? $("start-button")
        : phase !== "done"
          ? null
          : $("done-panel").dataset.step === "next"
            ? $("play-top")
            : $("rematch-button");
    if (button && !button.hidden) {
      event.preventDefault();
      button.click();
    }
    return;
  }
  if (phase !== "round") return;
  if (/^[1-4]$/.test(event.key) && !answered && openedRound === shownRound) {
    $("choices").querySelectorAll(".choice")[Number(event.key) - 1]?.click();
  } else if (
    event.key === " " &&
    !event.target.closest?.("button, a, summary")
  ) {
    event.preventDefault();
    toggle.click();
  }
});

// The quit control is a link; during a game it asks first.
{
  const dialog = $("quit-dialog");
  root.querySelectorAll(".game-quit").forEach((quit) =>
    quit.addEventListener("click", (event) => {
      if (!dialog?.showModal) return;
      event.preventDefault();
      dialog.showModal();
    }),
  );
}

setPhase("connecting");
connect();
