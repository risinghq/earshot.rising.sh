// The room's TV page. It watches the room over the same WebSocket as the
// phones, plays the clip and shows the game; the phones answer.
const root = document.getElementById("screen");
const code = root.dataset.code;
const $ = (id) => document.getElementById(id);
const show = (el, on) => {
  el.hidden = !on;
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const number = (value) => value.toLocaleString("en-US");
const roundMs = 15000;
// Mirrors scoreFor in src/play/quiz.ts: 1000 at the start, 100 at the end.
const worthAt = (ms) => (ms > 0 ? Math.round(100 + (900 * ms) / roundMs) : 0);
// The worth falls 60 points a second; a slower redraw moves it in visible,
// uneven jumps.
const tickMs = 50;
const modeLabels = { easy: "Easy", normal: "Normal", hard: "Hard" };
const cards = ["lobby", "game", "reveal", "final"].map((name) =>
  $(`screen-${name}`),
);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
// The same hash as hueOf in src/ui/person.tsx, so a person and a category
// keep the colours the server pages give them.
const hueOf = (text) =>
  [...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
const mono = (name) => {
  const span = el("span", "mono", [...name][0] ?? "?");
  span.style.setProperty("--hue", String(hueOf(name)));
  span.setAttribute("aria-hidden", "true");
  return span;
};
const host = (s) => s.players.find((p) => p.creator)?.name;

let ws;
let gone = false;
let phase = "connecting";
let offset = 0; // server time minus local time
let tickTimer = null;
let nextTimer = null;
let playTimer = null;
let loadedFor = 0; // the round number this screen last reported ready

// Browsers hold sound until the page gets a click. In the lobby the button
// asks for that click ahead of time; in a round it shows when a play was
// blocked. Once the page has had a click, Chrome and Firefox let every
// later clip play.
const audio = $("screen-clip");
const soundButton = $("screen-sound");
let wantsSound = false;
let blocked = false;
const activated = () =>
  navigator.getAutoplayPolicy?.("mediaelement") === "allowed" ||
  navigator.userActivation?.hasBeenActive === true;
function syncSound() {
  const lobby = phase === "lobby" && !activated();
  const stuck = wantsSound && blocked && audio.paused;
  show(soundButton, lobby || stuck);
}
audio.addEventListener("playing", () => {
  blocked = false;
  root.classList.add("is-live");
  syncSound();
});
audio.addEventListener("pause", () => root.classList.remove("is-live"));
// A clip never cuts off at its end either.
audio.addEventListener("timeupdate", () => {
  if (audio.duration - audio.currentTime < 0.8) stopClip();
});
soundButton.onclick = () => {
  if (wantsSound) audio.play().catch(() => {});
  else syncSound();
};
document.addEventListener("pointerdown", () => setTimeout(syncSound));

function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`,
  );
  ws.onopen = () => send({ type: "watch" });
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = (event) => {
    if (event.code === 1001) {
      closed("This room has closed.");
      return;
    }
    if (!gone) setTimeout(connect, 1000);
  };
}

function send(value) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(value));
}

function handle(message) {
  if (message.type === "error") {
    if (message.code === "gone") {
      closed("This room has closed. Start a new one from the hub.");
      ws.close();
      return;
    }
    error("Something went wrong.");
    return;
  }
  if (message.type === "state") render(message);
}

function error(text) {
  const node = $("screen-error");
  node.textContent = text;
  show(node, text !== "");
}

function closed(text) {
  gone = true;
  phase = "closed";
  stopClip();
  wantsSound = false;
  syncSound();
  cards.forEach((card) => show(card, false));
  error(text);
}

// The clip fades out over 600 ms rather than cutting off, then lets go of its
// source. A new clip arriving meanwhile cancels the fade.
function stopClip() {
  clearTimeout(playTimer);
  const url = audio.dataset.url;
  delete audio.dataset.url;
  const release = () => {
    if (audio.dataset.url !== undefined) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  };
  if (audio.paused || url === undefined) {
    release();
    return;
  }
  const from = audio.volume;
  const t0 = performance.now();
  const step = (t) => {
    if (audio.dataset.url !== undefined) {
      audio.volume = from;
      return;
    }
    // A frame's timestamp can precede t0, which would push k below 0.
    const k = Math.min(1, Math.max(0, (t - t0) / 600));
    audio.volume = from * (1 - k);
    if (k < 1) requestAnimationFrame(step);
    else {
      release();
      audio.volume = from;
    }
  };
  requestAnimationFrame(step);
}

function render(s) {
  error("");
  offset = s.now - Date.now();
  phase = s.phase;
  root.dataset.phase = s.phase;
  // The clip plays through its round's reveal and the final standings, so
  // the room hears the rest of the song; the lobby and the next load
  // silence it.
  if (s.phase !== "playing" && s.phase !== "reveal" && s.phase !== "done") {
    stopClip();
    wantsSound = false;
    blocked = false;
  }
  clearInterval(tickTimer);
  clearInterval(nextTimer);
  fillRoom(s);
  show($("screen-lobby"), s.phase === "lobby");
  show($("screen-game"), s.phase === "loading" || s.phase === "playing");
  show($("screen-reveal"), s.phase === "reveal");
  show($("screen-final"), s.phase === "done");
  if (s.phase === "lobby") renderLobby(s);
  if (s.phase === "loading" || s.phase === "playing") renderRound(s);
  if (s.phase === "reveal") renderReveal(s);
  if (s.phase === "done") renderDone(s);
  syncSound();
}

function fillRoom(s) {
  root.querySelectorAll("[data-room='category']").forEach((node) => {
    node.textContent = s.category;
  });
  root.querySelectorAll(".mosaic").forEach((node) => {
    node.style.setProperty("--hue", String(hueOf(s.categorySlug || "")));
  });
}

// "Waiting for <host> to …", with the host's monogram in front.
function waitLine(node, s, what, after = "") {
  const name = host(s);
  node.replaceChildren();
  if (name) node.append(mono(name));
  // One text span, so the row's gap falls only after the monogram.
  const text = el("span");
  text.append("Waiting for ", el("strong", "", name ?? "the host"));
  text.append(` to ${what}.${after}`);
  node.append(text);
}

function renderLobby(s) {
  $("screen-mode").textContent =
    `${modeLabels[s.mode] ?? ""} · ${s.rounds} rounds`;
  $("screen-seats").textContent = `${s.players.length} of ${s.seats}`;
  const rows = s.players.map((p) => {
    const li = el("li", p.connected ? "" : "is-away");
    li.append(mono(p.name), el("b", "", p.name));
    if (p.creator) li.append(el("span", "tv-tag", "Host"));
    else if (!p.connected) li.append(el("span", "tv-tag", "Away"));
    return li;
  });
  const open = Math.max(0, s.seats - s.players.length);
  const seats = Array.from({ length: open }, () => {
    const li = el("li", "is-open");
    li.append(el("span", "tv-seat-empty"), el("b", "", "Open seat"));
    return li;
  });
  $("screen-roster").replaceChildren(...rows, ...seats);
  const hint = $("screen-lobby-hint");
  if (s.kind === "match") {
    hint.replaceChildren("The game starts once everyone is connected.");
  } else waitLine(hint, s, "start the game");
}

// Done rounds are light, the current one is the accent.
function fillSegments(panel, s, current) {
  panel.querySelectorAll(".tv-segs li").forEach((li, i) => {
    li.className = i < current ? "is-done" : i === current ? "is-now" : "";
  });
}

function renderRound(s) {
  const playing = s.phase === "playing";
  const panel = $("screen-game");
  panel.classList.toggle("is-many", s.players.length > 4);
  $("screen-round-title").textContent = `Round ${s.round} of ${s.rounds}`;
  fillSegments(panel, s, s.round - 1);
  $("screen-loading").textContent = !playing
    ? "Getting the next song ready…"
    : !s.clip
      ? "Loading the clip…"
      : s.mode === "hard"
        ? "Type the title on your phone."
        : "Answer on your phone.";
  if (playing && s.clip && audio.dataset.url !== s.clip) {
    audio.dataset.url = s.clip;
    audio.src = s.clip;
  }
  // Like the phones, the screen tells the room once the clip can play; the
  // round starts on the last report or the server's timeout.
  if (playing && s.round !== loadedFor) {
    loadedFor = s.round;
    if (!s.clip) send({ type: "loaded" });
    else
      audio.addEventListener("canplay", () => send({ type: "loaded" }), {
        once: true,
      });
  }
  if (playing && s.clip) {
    wantsSound = true;
    // The clip starts on the server's stamp, the same moment the players'
    // phones open their answers — speed points stay fair.
    const begin = () => {
      audio.play().catch(() => {
        blocked = true;
        syncSound();
      });
    };
    const delay = s.startedAt - offset - Date.now();
    clearTimeout(playTimer);
    if (delay > 0) playTimer = setTimeout(begin, delay);
    else begin();
  }
  $("screen-answers").replaceChildren(
    ...s.players.map((p) => {
      const li = el("li", p.answered ? "is-done" : "");
      const text = el("span");
      text.append(
        el("b", "", p.name),
        el("small", "", p.answered ? "Answered" : "Thinking…"),
      );
      li.append(mono(p.name), text);
      return li;
    }),
  );
  const ring = $("screen-ring");
  const tick = () => {
    const left = playing
      ? Math.max(0, Math.min(roundMs, s.endsAt - offset - Date.now()))
      : roundMs;
    ring.style.setProperty("--left", String(left / roundMs));
    $("screen-count").textContent = Math.ceil(left / 1000);
    $("screen-worth").textContent = `seconds · worth ${number(worthAt(left))}`;
    if (left <= 0) clearInterval(tickTimer);
  };
  tick();
  if (playing) tickTimer = setInterval(tick, tickMs);
}

function renderReveal(s) {
  const r = s.reveal;
  const panel = $("screen-reveal");
  panel.classList.toggle("is-many", r.results.length > 4);
  $("screen-reveal-title").textContent = `Round ${r.number} of ${s.rounds}`;
  fillSegments(panel, s, r.number - 1);
  $("screen-reveal-track").textContent = r.title;
  $("screen-reveal-artist").textContent = r.original
    ? `${r.original} · ${r.artist}`
    : r.artist;
  $("screen-cover").style.setProperty("--hue", String(hueOf(r.title)));
  const cover = $("screen-reveal-cover");
  show(cover, !!r.cover);
  if (r.cover) cover.src = r.cover;
  const totals = new Map(s.players.map((p) => [p.name, p.score]));
  $("screen-reveal-scores").replaceChildren(
    ...[...r.results]
      .sort((a, b) => b.score - a.score)
      .map((result) => {
        const li = el("li", result.correct ? "is-right" : "");
        const points = el("span", "tv-pts", `+${number(result.score)}`);
        li.append(
          mono(result.name),
          el("b", "", result.name),
          points,
          el("span", "tv-total", number(totals.get(result.name) ?? 0)),
        );
        if (result.score > 0 && !reducedMotion) {
          const t0 = performance.now();
          const step = (t) => {
            const k = Math.min(1, (t - t0) / 500);
            points.textContent = `+${number(Math.round(result.score * k))}`;
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
        return li;
      }),
  );
  const last = r.number >= s.rounds;
  const next = () => {
    const left = Math.ceil(Math.max(0, r.until - offset - Date.now()) / 1000);
    $("screen-next").textContent = last
      ? `results in ${left} s`
      : `next round in ${left} s`;
  };
  next();
  nextTimer = setInterval(next, 250);
}

function renderDone(s) {
  const [first, ...rest] = s.standings;
  const panel = $("screen-final");
  panel.classList.toggle("is-many", rest.length > 4);
  const tied = rest.length > 0 && rest[0].score === first?.score;
  $("screen-winner-label").textContent = tied ? "Tied for first" : "Winner";
  const who = $("screen-winner");
  who.replaceChildren();
  if (first) who.append(mono(first.name), el("b", "", first.name));
  $("screen-winner-score").textContent = first ? number(first.score) : "";
  $("screen-winner-correct").textContent = first
    ? `${first.correct}/${s.rounds} correct`
    : "";
  $("screen-standings").replaceChildren(
    ...rest.map((p, i) => {
      const li = el("li");
      const text = el("span", "tv-who");
      text.append(
        el("b", "", p.name),
        el("small", "", `${p.correct}/${s.rounds} correct`),
      );
      li.append(
        el("span", "tv-rank", String(i + 2)),
        mono(p.name),
        text,
        el("span", "tv-score", number(p.score)),
      );
      return li;
    }),
  );
  const hint = $("screen-final-hint");
  if (s.kind === "match")
    hint.replaceChildren("Full results are on every phone.");
  else
    waitLine(hint, s, "start a rematch", " Full results are on every phone.");
}

connect();
