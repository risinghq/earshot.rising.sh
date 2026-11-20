const root = document.getElementById("screen");
const code = root.dataset.code;
const $ = (id) => document.getElementById(id);
const show = (el, on) => {
  el.hidden = !on;
};
const listenLabel = (link) =>
  `Listen on ${link.includes("apple.com") ? "Apple Music" : "Deezer"}`;
const cards = ["lobby", "game", "reveal", "final"].map((name) =>
  $(`screen-${name}`),
);
const modeLabels = {
  easy: "titles with artists",
  normal: "titles only",
  hard: "type the title",
};
// The same label the server renders in pages.tsx choiceLabel.
const choiceLabel = (choice) => {
  const label = document.createElement("span");
  label.className = "choice-label";
  const title = document.createElement("span");
  title.className = "choice-title";
  title.textContent = choice.title;
  label.append(title);
  if (choice.artist) {
    const artist = document.createElement("span");
    artist.className = "choice-artist";
    artist.textContent = choice.artist;
    label.append(artist);
  }
  return label;
};

let ws;
let offset = 0; // server time minus local time
let tickTimer = null;
let playTimer = null;
let loadedFor = 0; // the round number this screen last reported ready

// The page can set clip volume everywhere except iOS, where setting it is
// silently ignored; the slider stays hidden there.
const volumeProbe = document.createElement("audio");
volumeProbe.volume = 0.5;
const canSetVolume = volumeProbe.volume !== 1;
const volumeKey = "earshot-volume";
const savedVolume = localStorage.getItem(volumeKey);

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

{
  const audio = $("screen-clip");
  audio.volume = savedVolume === null ? 0.6 : Number(savedVolume) / 100;
  const volumeInput = $("screen-volume");
  if (volumeInput && canSetVolume) {
    volumeInput.hidden = false;
    volumeInput.value = String(Math.round(audio.volume * 100));
    volumeInput.oninput = () => {
      const v = Number(volumeInput.value);
      audio.volume = v / 100;
      localStorage.setItem(volumeKey, String(v));
    };
  }
  // The sound button follows the media element's real state: it shows only
  // while the round wants sound and a play attempt was blocked — a clip
  // that is merely still loading must not raise it.
  let wantsSound = false;
  let blocked = false;
  const syncSound = () =>
    show($("screen-sound"), wantsSound && blocked && audio.paused);
  audio.addEventListener("playing", () => {
    blocked = false;
    syncSound();
  });
  audio.syncSound = () => {
    wantsSound = true;
    syncSound();
  };
  audio.blockSound = () => {
    blocked = true;
    syncSound();
  };
  audio.stopSound = () => {
    wantsSound = false;
    blocked = false;
    syncSound();
  };
}

function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`,
  );
  ws.onopen = () => send({ type: "watch" });
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = (event) => {
    if (event.code === 1001) {
      connect.gone = true;
      error("This room has closed.");
      cards.forEach((card) => show(card, false));
      return;
    }
    if (!connect.gone) setTimeout(connect, 1000);
  };
}

function send(value) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(value));
}

function handle(message) {
  if (message.type === "error") {
    if (message.code === "gone") {
      connect.gone = true;
      error("This room is closed. Start a new one from the categories page.");
      cards.forEach((card) => show(card, false));
      ws.close();
      return;
    }
    error("Something went wrong.");
    return;
  }
  if (message.type === "state") render(message);
}

function error(text) {
  const el = $("screen-error");
  el.textContent = text;
  show(el, text !== "");
}

const row = (name, sub, count) => {
  const li = document.createElement("li");
  const track = document.createElement("div");
  track.className = "track";
  const b = document.createElement("b");
  b.textContent = name;
  track.append(b);
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    track.append(small);
  }
  const span = document.createElement("span");
  span.className = "count";
  span.textContent = count;
  li.append(track, span);
  return li;
};

function stopClip() {
  const audio = $("screen-clip");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  delete audio.dataset.url;
  clearTimeout(playTimer);
}

function render(s) {
  error("");
  offset = s.now - Date.now();
  // The clip plays through its round's reveal, so the room hears the rest of
  // the song; the lobby, the next load and the final standings silence it.
  if (s.phase !== "playing" && s.phase !== "reveal") {
    stopClip();
    $("screen-clip").stopSound();
  }
  show($("screen-lobby"), s.phase === "lobby");
  show($("screen-game"), s.phase === "loading" || s.phase === "playing");
  show($("screen-reveal"), s.phase === "reveal");
  show($("screen-final"), s.phase === "done");
  if (s.phase === "lobby") renderLobby(s);
  if (s.phase === "loading" || s.phase === "playing") renderRound(s);
  if (s.phase === "reveal") renderReveal(s);
  if (s.phase === "done") renderDone(s);
}

function renderLobby(s) {
  $("screen-category").textContent = `${s.category} · ${modeLabels[s.mode]}`;
  $("screen-lobby-hint").textContent =
    s.kind === "match"
      ? "The game starts as soon as everyone is connected."
      : "Waiting for the room's creator to start the game.";
  $("screen-roster").replaceChildren(
    ...s.players.map((p) => row(p.name, p.connected ? "" : "away", p.score)),
  );
}

function renderRound(s) {
  const playing = s.phase === "playing";
  $("screen-round-title").textContent = `Round ${s.round} of ${s.rounds}`;
  show($("screen-loading"), !playing || !s.clip);
  $("screen-loading").textContent = playing
    ? "Loading the clip…"
    : "Getting the next song ready…";
  show($("screen-bar").parentNode, playing);
  const audio = $("screen-clip");
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
    audio.syncSound();
    // The clip starts on the server's stamp, the same moment the players'
    // phones open their answers — speed points stay fair.
    const begin = () => {
      audio.play().catch(() => audio.blockSound());
    };
    const delay = s.startedAt - offset - Date.now();
    clearTimeout(playTimer);
    if (delay > 0) playTimer = setTimeout(begin, delay);
    else begin();
  }
  const box = $("screen-choices");
  show(box, playing && s.mode !== "hard");
  if (s.mode !== "hard" && s.choices) {
    if (box.dataset.round !== String(s.round)) {
      box.dataset.round = String(s.round);
      box.replaceChildren(
        ...s.choices.map((choice) => {
          const li = document.createElement("li");
          li.append(choiceLabel(choice));
          return li;
        }),
      );
    }
  }
  $("screen-answers").replaceChildren(
    ...s.players.map((p) => row(p.name, p.answered ? "answered" : "", p.score)),
  );
  clearInterval(tickTimer);
  if (playing) {
    const tick = () => {
      const left = Math.max(0, s.endsAt - offset - Date.now());
      $("screen-count").textContent = Math.ceil(left / 1000);
      $("screen-bar").style.transform = `scaleX(${left / 15000})`;
      if (left <= 0) clearInterval(tickTimer);
    };
    tick();
    tickTimer = setInterval(tick, 200);
  }
}

function renderReveal(s) {
  const r = s.reveal;
  $("screen-reveal-title").textContent = `Round ${r.number}`;
  $("screen-reveal-track").textContent = r.title;
  $("screen-reveal-artist").textContent = r.original
    ? `${r.original} · ${r.artist}`
    : r.artist;
  const cover = $("screen-reveal-cover");
  show(cover, !!r.cover);
  if (r.cover) cover.src = r.cover;
  const link = $("screen-reveal-link");
  show(link, !!r.link);
  if (r.link) {
    link.href = r.link;
    link.textContent = listenLabel(r.link);
  }
  $("screen-reveal-scores").replaceChildren(
    ...r.results.map((result) => {
      const li = row(
        result.name,
        result.correct
          ? "correct" +
              (result.streak >= 2 ? ` · ${result.streak} in a row` : "")
          : result.answer
            ? `answered ${result.answer}`
            : "no answer",
        `+${result.score}`,
      );
      li.classList.add(result.correct ? "is-right" : "is-wrong");
      const count = li.querySelector(".count");
      if (result.score > 0 && !reducedMotion) {
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / 500);
          count.textContent = `+${Math.round(result.score * k)}`;
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      return li;
    }),
  );
}

function renderDone(s) {
  $("screen-standings").replaceChildren(
    ...s.standings.map((p, index) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = index + 1;
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = p.name;
      track.append(name);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = p.score;
      li.append(rank, track, score);
      return li;
    }),
  );
  show($("screen-board-empty"), (s.board ?? []).length === 0);
  $("screen-board").replaceChildren(
    ...(s.board ?? []).map((entry, index) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = index + 1;
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = entry.name;
      track.append(name);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = entry.score.toLocaleString("en-US");
      li.append(rank, track, score);
      return li;
    }),
  );
}

$("screen-sound").onclick = () => {
  $("screen-clip")
    .play()
    .catch(() => {});
};

connect();
