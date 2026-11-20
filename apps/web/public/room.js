const root = document.getElementById("room");
const code = root.dataset.code;
const $ = (id) => document.getElementById(id);
const cards = ["join", "lobby", "game", "reveal", "final", "players"].map(
  (name) => $(`${name}-card`),
);
const show = (el, on) => {
  el.hidden = !on;
};
const listenLabel = (link) =>
  `Listen on ${link.includes("apple.com") ? "Apple Music" : "Deezer"}`;
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

const key = `quiz-room-${code}`;
const params = new URLSearchParams(location.search);
if (params.get("k")) {
  localStorage.setItem(key, params.get("k"));
  history.replaceState(null, "", `/play/room/${code}`);
}
$("room-link").textContent = `${location.origin}/play/room/${code}`;

// Reports go over fetch so the room socket stays connected.
const reportEl = $("reveal-report");
reportEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  fetch(form.action, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams(new FormData(form)),
  })
    .then((response) => {
      if (response.type === "opaqueredirect" || response.ok) {
        form.reset();
        reportEl.open = false;
        return;
      }
      const hint = reportEl.querySelector(".report-failed");
      if (hint) hint.hidden = false;
    })
    .catch(() => {
      const hint = reportEl.querySelector(".report-failed");
      if (hint) hint.hidden = false;
    });
});

let revealedTrack = null;

let ws;
let askedWithName = false; // the last join sent carried a nickname
let offset = 0; // server time minus local time
let tickTimer = null;
let playTimer = null;
let answered = false;
let loadedFor = 0; // the round number this device last reported ready

// The page can set clip volume everywhere except iOS, where setting it is
// silently ignored; the slider stays hidden there.
const volumeProbe = document.createElement("audio");
volumeProbe.volume = 0.5;
const canSetVolume = volumeProbe.volume !== 1;
const volumeKey = "earshot-volume";
const savedVolume = localStorage.getItem(volumeKey);

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const clip = $("clip");
const clipToggle = $("clip-toggle");
clipToggle.hidden = false;
clip.removeAttribute("controls");
clip.volume = savedVolume === null ? 0.6 : Number(savedVolume) / 100;
{
  const volumeInput = $("clip-volume");
  if (volumeInput && canSetVolume) {
    volumeInput.hidden = false;
    volumeInput.value = String(Math.round(clip.volume * 100));
    volumeInput.oninput = () => {
      const v = Number(volumeInput.value);
      clip.volume = v / 100;
      localStorage.setItem(volumeKey, String(v));
    };
  }
  // Mute works everywhere, iOS included, and holds across reloads.
  const muteKey = "earshot-muted";
  const mute = $("clip-volume-mute");
  if (mute) {
    const apply = (muted) => {
      clip.muted = muted;
      mute.setAttribute("aria-pressed", String(muted));
    };
    apply(localStorage.getItem(muteKey) === "1");
    mute.onclick = () => {
      const muted = mute.getAttribute("aria-pressed") !== "true";
      localStorage.setItem(muteKey, muted ? "1" : "0");
      apply(muted);
    };
  }
}
// The icon follows the media element's real state through its events.
// `hidden` is set as an attribute because the icons are SVG, where the
// .hidden property does not reflect.
const setClipIcon = () => {
  const playing = !clip.paused && !clip.ended;
  clipToggle.querySelector(".i-play").toggleAttribute("hidden", playing);
  clipToggle.querySelector(".i-pause").toggleAttribute("hidden", !playing);
  document.body.classList.toggle("clip-live", playing);
};
["play", "playing", "pause", "ended"].forEach((event) =>
  clip.addEventListener(event, setClipIcon),
);
clipToggle.onclick = () => {
  if (unlock()) return;
  if (clip.paused) clip.play().catch(() => {});
  else clip.pause();
};
clipToggle.classList.add("needs-click");
let unlocked = false;
function unlock() {
  if (unlocked) return false;
  unlocked = true;
  clipToggle.classList.remove("needs-click");
  // Gesture-bound media unlock: play and pause a silent clip on the element
  // rounds use, so the WebSocket-driven play() keeps the user activation.
  if (!clip.paused) return true;
  clip.src = "/silence.wav";
  clip.play().finally(() => {
    clip.pause();
    // Restore whatever clip the room last assigned, which may have changed
    // while the silent play was settling.
    if (clip.dataset.url) clip.src = clip.dataset.url;
    else clip.removeAttribute("src");
  });
  return true;
}

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
  $("room-meta").textContent =
    `Room ${s.code} · ${s.category} · ${modeLabels[s.mode]}`;
  // The clip plays through its round's reveal; the next load, the lobby and
  // the final standings silence it.
  if (s.phase !== "playing" && s.phase !== "reveal" && !clip.paused) {
    clip.pause();
  }
  renderPlayers(s);
  const joined = !!s.you.name;
  show($("join-card"), !joined);
  show($("players-card"), joined);
  show($("lobby-card"), s.phase === "lobby");
  show($("game-card"), s.phase === "loading" || s.phase === "playing");
  show($("reveal-card"), s.phase === "reveal");
  show($("final-card"), s.phase === "done");
  show($("room-sheet"), s.phase === "reveal");
  root.classList.toggle("sheet-open", s.phase === "reveal");
  renderBar(s);

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
  else revealedTrack = null;
  if (s.phase === "done") renderDone(s);
}

let lastStreak = 0;

// The game bar follows the room's phase: segments fill as rounds finish,
// the score is your running total, the streak shows once it reaches 2.
function renderBar(s) {
  const done =
    s.phase === "done"
      ? s.rounds
      : s.phase === "reveal"
        ? (s.reveal?.number ?? s.round ?? 0)
        : s.phase === "playing" || s.phase === "loading"
          ? s.round - 1
          : 0;
  const progress = root.querySelector(".game-progress");
  const playing = s.phase === "playing" || s.phase === "loading";
  progress.querySelectorAll(".seg").forEach((seg, i) => {
    seg.classList.toggle("is-done", i < done);
    seg.classList.toggle("is-current", i === done && playing);
  });
  const round = Math.min(done + (playing ? 1 : 0), s.rounds) || 1;
  progress.setAttribute("aria-valuenow", String(round));
  progress.setAttribute("aria-label", `Round ${round} of ${s.rounds}`);
  const mine = s.players.find((p) => p.name === s.you.name);
  root.querySelector(".game-score-n").textContent = (
    mine?.score ?? 0
  ).toLocaleString("en-US");
  show(root.querySelector(".game-streak"), lastStreak >= 2);
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
  show($("clip-status"), !playing || !s.clip);
  $("clip-status").textContent =
    playing && s.screen
      ? "The clip plays on the room's screen."
      : playing
        ? "Loading the clip…"
        : "Getting the next song ready…";
  show($("player-wrap"), playing && !s.screen);
  const audio = clip;
  if (s.screen) {
    // The clip moved to the screen mid-round: a phone already playing must
    // go silent, not just hide its player. Clearing the cached url lets the
    // next unscreened snapshot restore playback.
    if (audio.dataset.url !== undefined) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      delete audio.dataset.url;
    }
  } else if (playing && s.clip && audio.dataset.url !== s.clip) {
    audio.dataset.url = s.clip;
    audio.src = s.clip;
  }
  // Each device tells the room once its clip can play (or that there is no
  // clip to wait for, as on a screened room); the round starts on the last
  // report or the server's timeout.
  if (playing && s.round !== loadedFor) {
    loadedFor = s.round;
    if (s.screen || !s.clip) send({ type: "loaded" });
    else
      audio.addEventListener("canplay", () => send({ type: "loaded" }), {
        once: true,
      });
  }
  const mine = s.players.find((p) => p.name === s.you.name);
  answered = !!(mine && mine.answered);
  show($("answer-status"), answered);
  // Choices stay hidden until the server's round start, the same moment
  // the clip begins; anything earlier would be a blind guess.
  const openAnswers = () => {
    if (!answered && s.mode !== "hard") show($("choices"), true);
    if (!answered && s.mode === "hard") show($("typed-form"), true);
  };
  show($("choices"), false);
  show($("typed-form"), false);
  // When the room is on a screen, the clip plays there and the phone only
  // opens its answers at the server's round start.
  const begin = () => {
    if (!s.screen && s.clip) {
      audio.play().catch(() => clipToggle.classList.add("needs-click"));
    }
    openAnswers();
  };
  if (playing && (s.clip || s.screen)) {
    const delay = s.startedAt - offset - Date.now();
    clearTimeout(playTimer);
    if (delay > 0) playTimer = setTimeout(begin, delay);
    else begin();
  }
  if (s.mode !== "hard" && s.choices) {
    const box = $("choices");
    if (box.dataset.round !== String(s.round)) {
      box.dataset.round = String(s.round);
      box.replaceChildren(
        ...s.choices.map((choice, index) => {
          const button = document.createElement("button");
          button.className = "choice";
          button.type = "button";
          const key = document.createElement("span");
          key.className = "choice-key";
          key.setAttribute("aria-hidden", "true");
          key.textContent = String(index + 1);
          button.append(key, choiceLabel(choice));
          button.onclick = () => {
            send({ type: "answer", answer: choice.title });
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
      $("count-bar").style.setProperty("--left", String(left / 15000));
      // Mirrors scoreFor in src/play/quiz.ts.
      $("count-worth").textContent =
        left > 0 ? Math.round(100 + (900 * left) / 15000) : 0;
      if (left <= 0) clearInterval(tickTimer);
    };
    tick();
    tickTimer = setInterval(tick, 200);
  }
}

function renderReveal(s) {
  const r = s.reveal;
  const mine = r.results.find((result) => result.name === s.you.name);
  const sheet = $("room-sheet");
  sheet.classList.toggle("is-good", !!mine?.correct);
  sheet.classList.toggle("is-bad", !mine?.correct);
  show($("sheet-check"), !!mine?.correct);
  show($("sheet-cross"), !mine?.correct);
  $("sheet-verdict").textContent = mine?.correct
    ? "Correct"
    : mine?.answer
      ? "Not quite"
      : "No answer";
  const points = $("sheet-points");
  points.textContent = `+${mine?.score ?? 0}`;
  points.classList.toggle("is-none", !(mine?.score > 0));
  $("sheet-title").textContent = r.title;
  $("sheet-artist").textContent = r.original
    ? `${r.original} · ${r.artist}`
    : r.artist;
  const tile = sheet.querySelector(".cover-tile");
  tile.replaceChildren();
  if (r.cover) {
    const img = document.createElement("img");
    img.src = r.cover;
    img.alt = "";
    tile.append(img);
  }
  const link = $("sheet-link");
  show(link, !!r.link);
  if (r.link) {
    link.href = r.link;
    link.textContent = listenLabel(r.link);
  }
  $("sheet-next").textContent =
    r.number >= s.rounds ? "Results soon" : "Next round soon";
  lastStreak = mine?.streak ?? 0;
  const streak = root.querySelector(".game-streak");
  root.querySelector(".game-streak-n").textContent = String(lastStreak);
  show(streak, lastStreak >= 2);
  const report = $("reveal-report");
  show(report, !!r.track);
  if (r.track && r.track !== revealedTrack) {
    revealedTrack = r.track;
    report.open = false;
    report.querySelector("form").reset();
    const hint = report.querySelector(".report-failed");
    if (hint) hint.hidden = true;
    $("report-track").value = r.track;
    $("report-title").value = r.title;
    $("report-artist").value = r.artist;
    $("report-category").value = s.categorySlug || "";
    $("report-back").value = location.pathname;
  }
  $("reveal-scores").replaceChildren(
    ...r.results.map((result) => {
      const li = document.createElement("li");
      const mine = result.name === s.you.name;
      if (mine) li.classList.add(result.correct ? "is-right" : "is-wrong");
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      name.textContent = result.name;
      const sub = document.createElement("small");
      sub.textContent = result.correct
        ? "correct" + (result.streak >= 2 ? ` · ${result.streak} in a row` : "")
        : result.answer
          ? `answered ${result.answer}`
          : "no answer";
      track.append(name, sub);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = `+${result.score}`;
      // The player's own points count up; others show final numbers.
      if (mine && result.score > 0 && !reducedMotion) {
        const t0 = performance.now();
        const step = (t) => {
          const k = Math.min(1, (t - t0) / 500);
          score.textContent = `+${Math.round(result.score * k)}`;
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
      if (mine && result.correct && "vibrate" in navigator)
        navigator.vibrate(25);
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
  $("board").replaceChildren(
    ...(s.board ?? []).map((entry, index) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = index + 1;
      const track = document.createElement("div");
      track.className = "track";
      const name = document.createElement("b");
      const link = document.createElement("a");
      link.href = `/u/${encodeURIComponent(entry.name)}`;
      link.textContent = entry.name;
      name.append(link);
      track.append(name);
      const score = document.createElement("span");
      score.className = "count";
      score.textContent = entry.score.toLocaleString("en-US");
      li.append(rank, track, score);
      return li;
    }),
  );
  show($("board-empty"), (s.board ?? []).length === 0);
  show($("points-hint"), !s.you.user);
  const rematch = $("rematch-button");
  show(rematch, s.you.creator);
}

$("join-form").onsubmit = (event) => {
  event.preventDefault();
  unlock();
  askedWithName = true;
  send({
    type: "join",
    name: $("nickname").value,
    token: localStorage.getItem(key) || undefined,
  });
};
$("start-button").onclick = () => {
  unlock();
  send({ type: "start" });
};
$("rematch-button").onclick = () => {
  unlock();
  send({ type: "start" });
};
$("typed-form").onsubmit = (event) => {
  event.preventDefault();
  const input = $("typed-answer");
  if (!input.value.trim()) return;
  send({ type: "answer", answer: input.value });
  input.value = "";
  show($("typed-form"), false);
  show($("answer-status"), true);
};

// 1-4 answers while the choices are open, matching the card's number badge.
document.addEventListener("keydown", (event) => {
  if (event.repeat || document.querySelector("dialog[open]")) return;
  if (!/^[1-4]$/.test(event.key) || answered) return;
  if (event.target.closest?.("input, textarea, select")) return;
  const box = $("choices");
  if (box.hidden) return;
  box.querySelectorAll(".choice")[Number(event.key) - 1]?.click();
});

// The quit control is a link so it works without this script; with JS it
// opens the confirmation dialog instead.
{
  const quit = root.querySelector(".game-quit");
  const dialog = $("quit-dialog");
  if (quit && dialog?.showModal) {
    quit.addEventListener("click", (event) => {
      // The game being over means there is no progress left to lose, so
      // the link just leaves.
      if (!$("final-card").hidden) return;
      event.preventDefault();
      dialog.showModal();
    });
  }
}

connect();
