const root = document.getElementById("room");
const code = root.dataset.code;
const $ = (id) => document.getElementById(id);
const cards = ["join", "lobby", "game", "reveal", "final", "players"].map(
  (name) => $(`${name}-card`),
);
const show = (el, on) => {
  el.hidden = !on;
};

const key = `quiz-room-${code}`;
const params = new URLSearchParams(location.search);
if (params.get("k")) {
  localStorage.setItem(key, params.get("k"));
  history.replaceState(null, "", `/play/room/${code}`);
}
$("room-link").textContent = `${location.origin}/play/room/${code}`;

let ws;
let askedWithName = false; // the last join sent carried a nickname
let offset = 0; // server time minus local time
let tickTimer = null;
let playTimer = null;
let answered = false;

function connect() {
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/room/${code}/ws`,
  );
  ws.onopen = () => {
    const token = localStorage.getItem(key);
    // A visitor with no token joins only after typing a nickname; asking the
    // server now would come back "name" and show an error before input.
    if (token) send({ type: "join", token });
    else show($("join-card"), true);
  };
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
  if (message.type === "joined") {
    localStorage.setItem(key, message.token);
    show($("join-card"), false);
    show($("players-card"), true);
    return;
  }
  if (message.type === "error") {
    if (message.code === "gone") {
      connect.gone = true;
      error("This room is closed. Start a new one from the categories page.");
      cards.forEach((card) => show(card, false));
      ws.close();
      return;
    }
    show($("join-card"), true);
    // A token-only join that matches no player (the creator's first load)
    // also answers "name" — show the form, not a validation error.
    if (message.code === "name" && !askedWithName) return;
    error(
      {
        name: "Pick a nickname of 1 to 20 characters.",
        taken: "That nickname is taken in this room.",
        full: "This room is full.",
      }[message.code] || "Something went wrong.",
    );
    return;
  }
  if (message.type === "state") render(message);
}

function error(text) {
  const el = $("room-error");
  el.textContent = text;
  show(el, text !== "");
}

function render(s) {
  error("");
  offset = s.now - Date.now();
  $("room-meta").textContent = `Room ${s.code} · ${s.category} · ${
    s.mode === "choices" ? "four choices" : "type the title"
  }`;
  renderPlayers(s);
  const joined = !!s.you.name;
  show($("join-card"), !joined);
  show($("players-card"), joined);
  show($("lobby-card"), s.phase === "lobby");
  show($("game-card"), s.phase === "loading" || s.phase === "playing");
  show($("reveal-card"), s.phase === "reveal");
  show($("final-card"), s.phase === "done");

  if (s.phase === "lobby") {
    show($("start-button"), s.you.creator);
    $("lobby-hint").textContent =
      s.kind === "match"
        ? "The game starts as soon as everyone is connected."
        : s.you.creator
          ? "You created this room. Start when everyone is in."
          : "Waiting for the room's creator to start the game.";
  }
  if (s.phase === "loading" || s.phase === "playing") renderRound(s);
  if (s.phase === "reveal") renderReveal(s);
  if (s.phase === "done") renderDone(s);
}

function renderPlayers(s) {
  $("players").replaceChildren(
    ...s.players.map((p) => {
      const li = document.createElement("li");
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = p.name + (p.name === s.you.name ? " (you)" : "");
      const sub = document.createElement("small");
      sub.textContent = [
        p.creator ? "creator" : "",
        p.connected ? "" : "away",
        p.answered ? "answered" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      track.append(name, sub);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = p.score;
      li.append(track, score);
      return li;
    }),
  );
}

function renderRound(s) {
  const playing = s.phase === "playing";
  $("round-title").textContent = `Round ${s.round} of ${s.rounds}`;
  show($("clip-status"), !playing || !s.clip);
  $("clip-status").textContent = playing
    ? "Loading the clip…"
    : "Getting the next song ready…";
  show($("count-bar").parentNode, playing);
  const audio = $("clip");
  if (playing && s.clip && audio.dataset.url !== s.clip) {
    audio.dataset.url = s.clip;
    audio.src = s.clip;
  }
  const mine = s.players.find((p) => p.name === s.you.name);
  answered = !!(mine && mine.answered);
  show($("answer-status"), answered);
  // Choices stay hidden until the server's round start, the same moment
  // the clip begins; anything earlier would be a blind guess.
  const openAnswers = () => {
    if (!answered && s.mode === "choices") show($("choices"), true);
    if (!answered && s.mode === "typed") show($("typed-form"), true);
  };
  show($("choices"), false);
  show($("typed-form"), false);
  if (playing && s.clip) {
    const delay = s.startedAt - offset - Date.now();
    if (delay > 0) {
      clearTimeout(playTimer);
      playTimer = setTimeout(() => {
        audio.play().catch(() => {});
        openAnswers();
      }, delay);
    } else {
      audio.play().catch(() => {});
      openAnswers();
    }
  }
  if (s.mode === "choices" && s.choices) {
    const box = $("choices");
    if (box.dataset.round !== String(s.round)) {
      box.dataset.round = String(s.round);
      box.replaceChildren(
        ...s.choices.map((title) => {
          const button = document.createElement("button");
          button.className = "pill choice";
          button.type = "button";
          button.textContent = title;
          button.onclick = () => {
            send({ type: "answer", answer: title });
            answered = true;
            show(box, false);
            show($("answer-status"), true);
          };
          return button;
        }),
      );
    }
  }
  clearInterval(tickTimer);
  if (playing) {
    const tick = () => {
      const left = Math.max(0, s.endsAt - offset - Date.now());
      $("count-left").textContent = Math.ceil(left / 1000);
      $("count-bar").style.transform = `scaleX(${left / 15000})`;
      if (left <= 0) clearInterval(tickTimer);
    };
    tick();
    tickTimer = setInterval(tick, 200);
  }
}

function renderReveal(s) {
  const r = s.reveal;
  $("reveal-title").textContent = `Round ${r.number}`;
  $("reveal-track").textContent = r.title;
  $("reveal-artist").textContent = r.artist;
  const cover = $("reveal-cover");
  show(cover, !!r.cover);
  if (r.cover) cover.src = r.cover;
  const link = $("reveal-link");
  show(link, !!r.link);
  if (r.link) link.href = r.link;
  $("reveal-scores").replaceChildren(
    ...r.results.map((result) => {
      const li = document.createElement("li");
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = result.name;
      const sub = document.createElement("small");
      sub.textContent = result.correct
        ? "correct"
        : result.answer
          ? `answered ${result.answer}`
          : "no answer";
      track.append(name, sub);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = `+${result.score}`;
      li.append(track, score);
      return li;
    }),
  );
}

function renderDone(s) {
  $("standings").replaceChildren(
    ...s.standings.map((p) => {
      const li = document.createElement("li");
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = p.name;
      track.append(name);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = p.score;
      li.append(track, score);
      return li;
    }),
  );
  show($("points-hint"), !s.you.user);
  const rematch = $("rematch-button");
  show(rematch, s.you.creator);
}

$("join-form").onsubmit = (event) => {
  event.preventDefault();
  askedWithName = true;
  send({
    type: "join",
    name: $("nickname").value,
    token: localStorage.getItem(key) || undefined,
  });
};
$("start-button").onclick = () => send({ type: "start" });
$("rematch-button").onclick = () => send({ type: "start" });
$("typed-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $("typed-answer");
  if (!input.value.trim()) return;
  send({ type: "answer", answer: input.value });
  input.value = "";
  show($("typed-form"), false);
  show($("answer-status"), true);
};

connect();
