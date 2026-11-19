// Solo play stays on one page: answer and next-round submits go through
// fetch, so the tap that started the game keeps the document's media
// engagement and the next clip can start by itself. Without JavaScript the
// same forms post and reload the page, which also works.
//
// The page answers a tap before the server does. A picked choice sinks and
// the form locks at once; the verdict that comes back is morphed into the
// same buttons, so nothing reflows. Continue paints the next question from
// the copy /prepare sent during the reveal, while /next serves that round.
let audio = document.getElementById("clip");
const $ = (id) => document.getElementById(id);
const show = (el, on) => {
  el.hidden = !on;
};

// The page can set clip volume everywhere except iOS, where setting it is
// silently ignored; the slider stays hidden there.
const volumeProbe = document.createElement("audio");
volumeProbe.volume = 0.5;
const canSetVolume = volumeProbe.volume !== 1;
const volumeKey = "earshot-volume";
const savedVolume = localStorage.getItem(volumeKey);
const clipVolume = savedVolume === null ? 0.6 : Number(savedVolume) / 100;

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const roundMs = 15000;

let tickTimer = null;
// One action per screen: a second tap, a key repeat or the timeout firing
// while a submit is in flight is dropped here, and the server refuses a
// second answer anyway.
let busy = false;
// The next round as /prepare described it: its question page and a media
// element already loading its clip.
let prepared = null;
// Settles once /next has served the round on screen. A prefetched round is
// shown before the server has served it, and its clock may only be started
// after that.
let served = Promise.resolve();

const parseGame = (html) =>
  new DOMParser().parseFromString(html, "text/html").getElementById("game");

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: { "x-solo": "1" },
  });
  return parseGame(await response.text());
}

// The icon follows the media element's real state through its events, never
// a guess from play() resolving. `hidden` is set as an attribute because the
// icons are SVG, where the .hidden property does not reflect.
function syncIcon() {
  const toggle = $("clip-toggle");
  if (!toggle || !audio) return;
  const playing = !audio.paused && !audio.ended;
  toggle.querySelector(".i-play").toggleAttribute("hidden", playing);
  toggle.querySelector(".i-pause").toggleAttribute("hidden", !playing);
  toggle.classList.toggle("needs-click", false);
  document.body.classList.toggle("clip-live", playing);
}

function wireVolume() {
  const input = $("clip-volume");
  if (!input) return;
  if (audio) audio.volume = clipVolume;
  if (!canSetVolume) {
    input.hidden = true;
    return;
  }
  input.hidden = false;
  input.value = String(Math.round(clipVolume * 100));
  input.oninput = () => {
    const v = Number(input.value);
    if (audio) audio.volume = v / 100;
    localStorage.setItem(volumeKey, String(v));
  };
}

// The bar runs down as one compositor transition; the timer only updates
// the seconds and ends the round. Reduced motion has no transitions, so the
// timer steps the bar there instead.
function runBar(bar, remaining) {
  bar.style.transition = "none";
  bar.style.transform = `scaleX(${remaining / roundMs})`;
  if (reducedMotion) return;
  bar.getBoundingClientRect();
  bar.style.transition = `transform ${remaining}ms linear`;
  bar.style.transform = "scaleX(0)";
}

// The server's clock starts when this clip reports "playing": the bar stays
// full until the report comes back, then runs down the server's remaining
// time. A blocked autoplay reports when the player presses play instead.
function wireClock(round, form) {
  const bar = $("count-bar");
  const left = $("count-left");
  let reported = false;
  let ticking = false;
  const startTick = (remaining) => {
    if (ticking || $("round") !== round) return;
    ticking = true;
    const deadline = performance.now() + remaining;
    runBar(bar, remaining);
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      const ms = Math.max(0, deadline - performance.now());
      left.textContent = String(Math.ceil(ms / 1000));
      if (reducedMotion) bar.style.transform = `scaleX(${ms / roundMs})`;
      if (ms <= 0) {
        clearInterval(tickTimer);
        if (form) answer(form, null);
      }
    }, 250);
  };
  const report = () => {
    if (reported) return;
    reported = true;
    served
      .then(() =>
        fetch(`/play/${round.dataset.game}/playing`, { method: "POST" }),
      )
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(({ remaining }) => startTick(remaining))
      // A failed report falls back to the serve-time countdown the page
      // carried, so the round still ends on its own.
      .catch(() => startTick(Number(round.dataset.remaining || roundMs)));
  };
  audio.addEventListener("playing", report);
  // The clip may already be playing if it was instant (a preloaded round).
  if (!audio.paused) report();
}

function wirePlayer(round) {
  audio = round.querySelector("#clip");
  const toggle = $("clip-toggle");
  const form = $("answer-form");
  if (!toggle) return;
  audio.removeAttribute("controls");
  show(toggle, true);
  // Assigning src again restarts the download, so a preloaded clip keeps
  // the one it has.
  if (audio.getAttribute("src") !== round.dataset.src)
    audio.src = round.dataset.src;
  wireVolume();
  ["play", "playing", "pause", "ended"].forEach((event) =>
    audio.addEventListener(event, syncIcon),
  );
  toggle.onclick = () => {
    if (audio.paused) {
      audio.play().catch(() => toggle.classList.add("needs-click"));
    } else audio.pause();
  };
  audio.play().catch(() => toggle.classList.add("needs-click"));
  wireClock(round, form);
}

// While the reveal is up, ask for the next round's clip and its question
// page, so Continue paints at once on audio that is already fetched. The
// final reveal has no next round, so it skips the lookup.
function prepare(round) {
  prepared = null;
  if (round.dataset.last === "1") return;
  fetch(`/play/${round.dataset.game}/prepare`, { method: "POST" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(({ url, html }) => {
      const next = html ? parseGame(html) : null;
      if (!url || !next || $("round") !== round) return;
      const clip = document.createElement("audio");
      clip.preload = "auto";
      clip.src = url;
      prepared = { url, next, clip };
    })
    .catch(() => {});
}

// A right answer counts the points up and taps the phone; the burst and the
// miss's shake are markup and CSS.
function celebrate(round) {
  const points = round.querySelector(".sheet-points");
  const score = Number(round.dataset.score || 0);
  const correct = round.dataset.correct === "1";
  if (correct && "vibrate" in navigator) navigator.vibrate(25);
  if (points && score > 0 && !reducedMotion) {
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 500);
      points.textContent = `+${Math.round(score * k)}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// The bar's segments, streak and score take the reply's values in place,
// so the segment fill and the streak animate instead of being replaced.
function morphBar(next) {
  const segs = document.querySelectorAll(".game-progress .seg");
  next.querySelectorAll(".game-progress .seg").forEach((seg, i) => {
    if (segs[i]) segs[i].className = seg.className;
  });
  const progress = document.querySelector(".game-progress");
  const label = next.querySelector(".game-progress");
  if (progress && label) {
    progress.setAttribute("aria-label", label.getAttribute("aria-label"));
    progress.setAttribute("aria-valuenow", label.getAttribute("aria-valuenow"));
  }
  const streak = document.querySelector(".game-streak");
  const nextStreak = next.querySelector(".game-streak");
  if (streak && nextStreak) {
    streak.hidden = nextStreak.hidden;
    streak.querySelector(".game-streak-n").textContent =
      nextStreak.querySelector(".game-streak-n").textContent;
  }
  const score = document.querySelector(".game-score-n");
  const nextScore = next.querySelector(".game-score-n");
  if (score && nextScore) score.textContent = nextScore.textContent;
}

// The cover arrives with the verdict; it fades in once decoded rather than
// popping into the tile.
function fadeCovers(root) {
  root.querySelectorAll(".cover-tile img").forEach((img) => {
    if (img.complete) return;
    img.classList.add("is-loading");
    img.addEventListener("load", () => img.classList.remove("is-loading"), {
      once: true,
    });
  });
}

// The verdict lands in the question's own elements: the choices keep their
// boxes and take the verdict's classes and icons, the player stays where it
// was, and the sheet slides up over them.
function showVerdict(next) {
  const round = $("round");
  const nextRound = next.querySelector("#round");
  const form = $("answer-form");
  const verdict = nextRound.querySelector(".reveal-choices, .reveal-typed");
  if (!round || !form || !verdict) return swap(next);
  morphBar(next);
  for (const key of Object.keys(round.dataset)) delete round.dataset[key];
  Object.assign(round.dataset, nextRound.dataset);
  const buttons = form.querySelectorAll(".choice");
  const results = verdict.querySelectorAll(".choice");
  if (verdict.classList.contains("reveal-choices") && buttons.length) {
    buttons.forEach((button, i) => {
      const result = results[i];
      if (!result) return;
      button.className = result.className;
      button.type = "button";
      button.disabled = true;
      button.replaceChildren(...result.childNodes);
    });
    form.className = verdict.className;
    form.removeAttribute("id");
  } else form.replaceWith(verdict);
  round.querySelector(".player")?.classList.add("is-over");
  const sheet = nextRound.querySelector("#sheet");
  round.append(sheet);
  fadeCovers(sheet);
  wireForms(sheet);
  enterReveal(round);
}

function enterReveal(round) {
  clearInterval(tickTimer);
  audio?.pause();
  document.body.classList.remove("clip-live");
  celebrate(round);
  prepare(round);
  // The sheet's Continue is the round's one next step; landing focus there
  // keeps Enter and Space advancing without a tab stop.
  $("continue-button")?.focus({ preventScroll: true });
}

function swap(next) {
  if (next === null) {
    location.reload();
    return;
  }
  // A detached media element keeps playing, so the old clip stops here.
  audio?.pause();
  $("game").replaceWith(next);
  wire(next);
}

async function answer(form, submitter) {
  if (busy) return;
  busy = true;
  clearInterval(tickTimer);
  // The bar stops where the answer caught it.
  const bar = $("count-bar");
  if (bar) {
    bar.style.transform = getComputedStyle(bar).transform;
    bar.style.transition = "none";
  }
  submitter?.classList.add("is-picked");
  form.classList.add("is-locked");
  // FormData is read before the lock disables anything, since a disabled
  // control is left out of it.
  const body = new FormData(form, submitter || undefined);
  form.querySelectorAll("button, input").forEach((control) => {
    control.disabled = true;
  });
  try {
    const next = await post(form.action, body);
    const phase = next?.querySelector("#round")?.dataset.phase;
    if (phase === "reveal") showVerdict(next);
    else swap(next);
  } catch {
    location.reload();
  } finally {
    busy = false;
  }
}

// A prefetched round is on screen before /next replies. A reply serving that
// same clip changes nothing; any other reply (the game ended, the round was
// re-resolved) replaces the page.
async function advance(form, submitter) {
  if (busy) return;
  busy = true;
  const ready = prepared;
  prepared = null;
  const reply = post(form.action, new FormData(form, submitter || undefined));
  try {
    if (ready) {
      const round = ready.next.querySelector("#round");
      const clip = round.querySelector("#clip");
      for (const { name, value } of clip.attributes)
        if (name !== "src") ready.clip.setAttribute(name, value);
      clip.replaceWith(ready.clip);
      let settle;
      served = new Promise((resolve) => {
        settle = resolve;
      });
      swap(ready.next);
      const next = await reply.finally(() => settle());
      const nextRound = next?.querySelector("#round");
      if (
        nextRound?.dataset.phase !== "question" ||
        nextRound.dataset.src !== round.dataset.src
      )
        swap(next);
    } else {
      submitter?.classList.add("is-busy");
      swap(await reply);
    }
  } catch {
    location.reload();
  } finally {
    busy = false;
  }
}

// A report is sent in the background and its disclosure becomes the
// server's answer, so the sheet stays where it is.
async function report(form) {
  const details = form.closest("details");
  form.querySelector("button").disabled = true;
  // The route answers a stored report with a redirect back to the game,
  // which this page does not need to load.
  const response = await fetch(form.action, {
    method: "POST",
    body: new FormData(form),
    redirect: "manual",
  }).catch(() => null);
  const note = document.createElement("p");
  note.className = "meta report-done";
  note.textContent =
    response?.type === "opaqueredirect" || response?.ok === true
      ? "Reported. Thanks."
      : ((await response?.text()) ?? "The report did not go through.");
  details.replaceWith(note);
}

function wireForms(root) {
  root.querySelectorAll("form[data-solo]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.classList.contains("report-form")) report(form);
      else if (form.id === "answer-form") answer(form, event.submitter);
      else advance(form, event.submitter);
    });
  });
}

function wire(root) {
  const round = root.querySelector("#round");
  clearInterval(tickTimer);
  // The quit control is a link so a no-JS page still leaves; with JS it
  // opens the confirmation dialog instead.
  const quit = root.querySelector(".game-quit");
  const dialog = root.querySelector("#quit-dialog");
  if (quit && dialog?.showModal) {
    quit.addEventListener("click", (event) => {
      event.preventDefault();
      dialog.showModal();
    });
  }
  wireForms(root);
  if (!round) return;
  if (round.dataset.phase === "question") wirePlayer(round);
  else if (round.dataset.phase === "reveal") {
    fadeCovers(round);
    enterReveal(round);
  } else {
    audio?.pause();
    document.body.classList.remove("clip-live");
  }
}

// Keyboard: 1-4 answers while a question is open, Enter or Space advances
// from the sheet. Number keys do nothing once the sheet is up.
document.addEventListener("keydown", (event) => {
  if (event.repeat || document.querySelector("dialog[open]")) return;
  const round = $("round");
  if (!round) return;
  const phase = round.dataset.phase;
  if (phase === "question" && /^[1-4]$/.test(event.key)) {
    if (event.target.closest?.("input, textarea, select")) return;
    document
      .querySelectorAll("#answer-form .choice")
      [Number(event.key) - 1]?.click();
  } else if (
    phase === "reveal" &&
    (event.key === "Enter" || event.key === " ")
  ) {
    if (event.target.closest?.("button, a, summary, input, select, textarea"))
      return;
    event.preventDefault();
    $("continue-button")?.click();
  }
});

wire($("game"));
