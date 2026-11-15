const root = document.getElementById("match");
const slug = root.dataset.category;
const signedIn = root.dataset.signedIn === "1";
const $ = (id) => document.getElementById(id);
const show = (el, on) => {
  el.hidden = !on;
};

let ws;
let timer = null;
let left = false; // matched or gave up; a close after this needs no retry
const waitAfterMs = 60_000;

function error(text) {
  const el = $("match-error");
  el.textContent = text;
  show(el, text !== "");
}

let startedAt = 0;

function connect(name) {
  left = false;
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play/match/${slug}/ws`,
  );
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", name }));
  };
  ws.onmessage = (event) => handle(JSON.parse(event.data));
  ws.onclose = () => {
    if (!left) setTimeout(() => connect(name), 1000);
  };
}

function startWaiting() {
  show($("match-name-card"), false);
  show($("match-search-card"), true);
  if (startedAt === 0) startedAt = Date.now();
  clearInterval(timer);
  timer = setInterval(() => {
    const waited = Date.now() - startedAt;
    $("match-waited").textContent = String(Math.floor(waited / 1000));
    if (waited >= waitAfterMs) {
      $("match-status").textContent =
        "No one else is looking right now. Keep waiting or play on your own.";
      show($("match-actions"), true);
      clearInterval(timer);
    }
  }, 500);
}

function handle(message) {
  if (message.type === "queued") {
    startWaiting();
    return;
  }
  if (message.type === "matched") {
    left = true;
    clearInterval(timer);
    ws.close();
    location.href = `/play/room/${message.code}?k=${message.token}`;
    return;
  }
  if (message.type === "error") {
    left = true;
    clearInterval(timer);
    ws.close();
    show($("match-search-card"), false);
    if (message.code === "taken" && signedIn) {
      error(
        "A match is already waiting under your name. Try again in a moment.",
      );
    } else if (message.code === "name" || message.code === "taken") {
      show($("match-name-card"), true);
      error(
        message.code === "taken"
          ? "Someone else is waiting with that nickname. Pick another."
          : "Pick a nickname of 1 to 20 characters.",
      );
    } else {
      error("The match could not be started. Try again in a moment.");
    }
  }
}

if (signedIn) {
  connect();
} else {
  show($("match-name-card"), true);
}

$("match-name-form").onsubmit = (event) => {
  event.preventDefault();
  error("");
  connect($("match-nickname").value);
};

$("match-stop").onclick = () => {
  show($("match-actions"), false);
  $("match-status").textContent = "Still searching…";
  clearInterval(timer);
  timer = setInterval(() => {
    $("match-waited").textContent = String(
      Math.floor((Date.now() - startedAt) / 1000),
    );
  }, 500);
};
