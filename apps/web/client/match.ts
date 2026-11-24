// The matchmaking page: joins the queue over a socket, counts the wait, and
// goes to the room the matchmaker opens. The server renders every card; this
// shows and hides them.
import type {
  MatchClientMessage,
  MatchServerMessage,
} from "../src/play/room/protocol";

const root = document.getElementById("match")!;
const slug = root.dataset.category;
const signedIn = root.dataset.signedIn === "1";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const show = (el: HTMLElement, on: boolean) => {
  el.hidden = !on;
};

let ws: WebSocket;
let timer: ReturnType<typeof setInterval> | undefined;
let left = false; // matched or gave up; a close after this needs no retry
let startedAt = 0;
const waitAfterMs = 60_000;

function error(text: string) {
  const el = $("match-error");
  el.textContent = text;
  show(el, text !== "");
}

function send(message: MatchClientMessage) {
  ws.send(JSON.stringify(message));
}

function connect(name?: string) {
  left = false;
  const era = root.dataset.era ? `?era=${root.dataset.era}` : "";
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(
    `${scheme}://${location.host}/play/match/${slug}/ws${era}`,
  );
  ws.onopen = () => send({ type: "join", name });
  ws.onmessage = (event) =>
    handle(JSON.parse(event.data) as MatchServerMessage);
  ws.onclose = () => {
    if (!left) setTimeout(() => connect(name), 1000);
  };
}

function countWait(giveUpAfter: number | null) {
  clearInterval(timer);
  timer = setInterval(() => {
    const waited = Date.now() - startedAt;
    $("match-waited").textContent = String(Math.floor(waited / 1000));
    if (giveUpAfter !== null && waited >= giveUpAfter) {
      $("match-status").textContent =
        "No one else is looking right now. Keep waiting or play on your own.";
      show($("match-actions"), true);
      clearInterval(timer);
    }
  }, 500);
}

function startWaiting() {
  show($("match-name-card"), false);
  show($("match-search-card"), true);
  if (startedAt === 0) startedAt = Date.now();
  countWait(waitAfterMs);
}

function leave() {
  left = true;
  clearInterval(timer);
  ws.close();
}

function handle(message: MatchServerMessage) {
  switch (message.type) {
    case "queued":
      startWaiting();
      return;
    case "matched":
      leave();
      location.href = `/play/room/${message.code}?k=${message.token}`;
      return;
    case "error":
      leave();
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
  connect($<HTMLInputElement>("match-nickname").value);
};

$("match-stop").onclick = () => {
  show($("match-actions"), false);
  $("match-status").textContent = "Still searching…";
  countWait(null);
};
