// The room as this device sees it. The server sends the whole room on every
// change; this module keeps the latest state and the device's own state
// around it (the clock offset, the round's timers, this player's pick), and
// sends the player's actions. Components read its signals and call its
// actions; nothing else writes to them.
import { createSignal } from "solid-js";
import type {
  ClientMessage,
  JoinError,
  RoomPreview,
  RoomState,
  ServerMessage,
} from "../../src/play/protocol";
import { roundSeconds, type Mode } from "../../src/play/rules";
import type { Clip } from "./clip";
import { joinErrors, mineOf } from "./text";

export type View =
  | "connecting"
  | "join"
  | "lobby"
  | "round"
  | "done"
  | "closed"
  | "away";

export const roundMs = roundSeconds * 1000;
// The worth falls 60 points a second; a slower redraw moves it in visible,
// uneven jumps.
const tickMs = 50;

export interface RoomDeps {
  code: string;
  signedIn: boolean;
  clip: Clip;
  send: (message: ClientMessage) => void;
  // Ends the socket's reconnecting, for a visit that is over.
  stop: () => void;
  close: () => void;
  reopen: () => void;
  // Posts the host's pick to the room's switch endpoint.
  post: (path: string, body: FormData) => Promise<Response>;
}

export function createRoom(deps: RoomDeps) {
  const { code, clip } = deps;
  const tokenKey = `quiz-room-${code}`;
  const nicknameKey = "earshot-nickname";

  const [state, setState] = createSignal<RoomState | null>(null);
  const [preview, setPreview] = createSignal<RoomPreview | null>(null);
  const [view, setView] = createSignal<View>("connecting");
  const [error, setError] = createSignal("");
  const [full, setFull] = createSignal(false);
  // Asks the join form to take focus; counts up on each request.
  const [askName, setAskName] = createSignal(0);
  // The round the stage is set up for, and its phase on the stage.
  const [shownRound, setShownRound] = createSignal(0);
  const [stagePhase, setStagePhase] = createSignal<"question" | "reveal">(
    "question",
  );
  // The round whose answers are open, and the clip's countdown.
  const [opened, setOpened] = createSignal(0);
  const [left, setLeft] = createSignal(roundMs);
  // Before the clip starts: "Get ready" or "Watch the TV".
  const [waiting, setWaiting] = createSignal<string | null>(null);
  // This player's pick, sent before the server echoes it.
  const [picked, setPicked] = createSignal<string | null>(null);
  // When the reveal's bar fills, measured once per round so it never jumps.
  const [revealMs, setRevealMs] = createSignal(0);
  const [doneStep, setDoneStep] = createSignal<"results" | "next">("results");

  let offset = 0; // server time minus local time
  let typedJoin = false; // the last join carried a nickname the player typed
  let loadedFor = 0; // the round this device last reported ready
  let revealedRound = 0;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let playTimer: ReturnType<typeof setTimeout> | undefined;

  const serverNow = () => Date.now() + offset;
  const token = () => localStorage.getItem(tokenKey) || undefined;

  function clearTimers() {
    clearInterval(tickTimer);
    clearTimeout(playTimer);
  }

  // Everyone is seated on arrival: the token finds a returning player or
  // the creator, a signed-in player sits under their profile name, and a
  // guest under the nickname they used last. Only a guest with no saved
  // nickname is asked for one.
  function arrive() {
    const saved = deps.signedIn ? "" : localStorage.getItem(nicknameKey) || "";
    typedJoin = false;
    deps.send({ type: "join", token: token(), name: saved || undefined });
  }

  function join(name: string) {
    typedJoin = true;
    deps.send({ type: "join", name, token: token() });
  }

  // The closed view: the room ended, or it is full and this device holds no
  // seat.
  function closed(isFull = false) {
    deps.stop();
    setError("");
    setFull(isFull);
    setView("closed");
    clip.fadeOut();
  }

  // The seat moved to another device. This one stops reconnecting until it
  // takes the seat back, which moves it here again.
  function away() {
    deps.stop();
    clearTimers();
    clip.fadeOut();
    setView("away");
  }

  function takeBack() {
    setView("connecting");
    deps.reopen();
  }

  function receive(message: ServerMessage) {
    switch (message.type) {
      case "moved":
        return away();
      case "joined":
        localStorage.setItem(tokenKey, message.token);
        if (typedJoin) localStorage.setItem(nicknameKey, message.name);
        return;
      case "preview":
        return setPreview(message);
      case "error":
        return joinError(message.code);
      case "state":
        return render(message);
    }
  }

  function joinError(code: JoinError) {
    if (code === "gone" || code === "full") {
      closed(code === "full");
      deps.close();
      return;
    }
    setView("join");
    // The arrival join has no typed name, so "name" just means "ask".
    if (code === "name" && !typedJoin) {
      setAskName((n) => n + 1);
      return;
    }
    setError(
      code === "taken" && !typedJoin
        ? `${localStorage.getItem(nicknameKey)} is taken in this room. Pick another.`
        : joinErrors[code],
    );
  }

  function render(s: RoomState) {
    offset = s.now - Date.now();
    setState(s);
    if (!s.you.name) return; // not seated yet; the join answer decides
    setError("");
    const next: View =
      s.phase === "lobby" ? "lobby" : s.phase === "done" ? "done" : "round";
    // The last song plays on under the final standings.
    if (next !== "round") clearTimers();
    if (next === "lobby") clip.fadeOut();
    // A finished game opens on its results, not on the step left open last.
    if (next !== "done" || view() !== "done") setDoneStep("results");
    setView(next);
    if (next !== "round") setShownRound(0);
    if (s.phase === "loading" || s.phase === "playing") question(s);
    if (s.phase === "reveal") reveal(s);
  }

  // A new round resets the stage: the now-playing card goes, the ring comes
  // back, and skeleton choices hold the answers' place until the clip
  // starts.
  function setUpRound(round: number) {
    setShownRound(round);
    setOpened(0);
    revealedRound = 0;
    setPicked(null);
    clearTimers();
    setStagePhase("question");
    setLeft(roundMs);
  }

  function question(s: RoomState) {
    const round = s.round ?? 1;
    if (round !== shownRound() || stagePhase() !== "question")
      setUpRound(round);
    if (s.phase === "loading" || !s.endsAt || !s.startedAt) {
      setWaiting("Get ready");
      return;
    }
    // The clip goes to every phone at once; on a screened room it plays on
    // the TV and phones only answer.
    if (s.screen) clip.clear();
    else if (s.clip) clip.load(s.clip);
    // Each device tells the room when its clip can play; the round starts
    // on the last report or the server's timeout.
    if (round !== loadedFor) {
      loadedFor = round;
      const report = () => deps.send({ type: "loaded" });
      if (s.screen || !s.clip) report();
      else clip.whenReady(report);
    }
    const delay = s.startedAt - serverNow();
    clearTimeout(playTimer);
    if (opened() === round) return;
    if (delay > 0) {
      setWaiting(s.screen ? "Watch the TV" : "Get ready");
      playTimer = setTimeout(() => openRound(s), delay);
    } else openRound(s);
  }

  // The server's round start: the clip plays, the answers open and the
  // clock runs. Answers stay hidden until then.
  function openRound(s: RoomState) {
    setOpened(s.round ?? 0);
    setWaiting(null);
    if (!s.screen && s.clip)
      clip.start((serverNow() - (s.startedAt ?? 0)) / 1000);
    const endsAt = s.endsAt ?? 0;
    const tick = () => {
      const ms = Math.max(0, endsAt - serverNow());
      setLeft(ms);
      if (ms <= 0) clearInterval(tickTimer);
    };
    tick();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, tickMs);
  }

  function reveal(s: RoomState) {
    const r = s.reveal!;
    if (r.number !== shownRound()) setUpRound(r.number);
    if (revealedRound === r.number) return;
    revealedRound = r.number;
    clearTimers();
    setWaiting(null);
    setRevealMs(Math.max(0, r.until - serverNow()));
    setStagePhase("reveal");
    if (mineOf(s, r)?.correct && "vibrate" in navigator) navigator.vibrate(25);
  }

  // This round's answer: the one sent from here, or the server's after a
  // reload.
  const answer = () => picked() ?? state()?.you.answer ?? null;
  const answered = () => answer() !== null;
  const answersOpen = () =>
    view() === "round" &&
    stagePhase() === "question" &&
    opened() !== 0 &&
    opened() === shownRound();

  // A pick locks in at once.
  function pick(title: string) {
    if (answered() || !answersOpen()) return;
    setPicked(title);
    deps.send({ type: "answer", answer: title });
  }

  function type(text: string) {
    if (!text.trim() || answered()) return;
    setPicked(text);
    deps.send({ type: "answer", answer: text });
  }

  // The host's pick goes through the same switch the hub posts; with start,
  // the next game begins without a stop in the lobby.
  function switchTo(slug: string, mode: Mode, start: boolean) {
    const body = new FormData();
    body.set("category", slug);
    body.set("mode", mode);
    body.set("k", token() ?? "");
    if (start) body.set("start", "1");
    setError("");
    return deps
      .post(`/play/room/${code}/switch`, body)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
      })
      .catch(() =>
        setError("That pick did not load. Try it again or pick another."),
      );
  }

  return {
    code,
    signedIn: deps.signedIn,
    clip,
    state,
    preview,
    // What every view shows of the room itself: its category and mode.
    room: () => state() ?? preview(),
    view,
    error,
    full,
    askName,
    shownRound,
    stagePhase,
    opened,
    left,
    waiting,
    revealMs,
    doneStep,
    setDoneStep,
    answer,
    answered,
    answersOpen,
    token,
    arrive,
    join,
    receive,
    closed,
    away,
    takeBack,
    pick,
    type,
    start: () => deps.send({ type: "start" }),
    vote: (id: string) => deps.send({ type: "vote", id }),
    suggest: (category: string, mode: Mode) =>
      deps.send({ type: "suggest", category, mode }),
    switchTo,
  };
}

export type Room = ReturnType<typeof createRoom>;
