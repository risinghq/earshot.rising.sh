// Solo play stays on one page: answer and next-round submits go through
// fetch and swap the #game region, so the tap that started the game keeps the
// document's media engagement and the next clip can start by itself. Without
// JavaScript the same forms post and reload the page, which also works.
const game = document.getElementById("game");
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

let tickTimer = null;

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

// The server's clock starts when this clip reports "playing" — the bar stays
// full until the report comes back, then runs down the server's remaining
// time. A blocked autoplay reports when the player presses play instead.
function wireClock(round, form) {
  const bar = $("count-bar");
  const left = $("count-left");
  let reported = false;
  let ticking = false;
  const startTick = (remaining) => {
    if (ticking) return;
    ticking = true;
    const deadline = performance.now() + remaining;
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      const ms = Math.max(0, deadline - performance.now());
      left.textContent = String(Math.ceil(ms / 1000));
      bar.style.transform = `scaleX(${ms / 15000})`;
      if (ms <= 0) {
        clearInterval(tickTimer);
        audio.pause();
        if (form) send(form, null);
      }
    }, 200);
  };
  const report = () => {
    if (reported) return;
    reported = true;
    fetch(`/play/${round.dataset.game}/playing`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(({ remaining }) => startTick(remaining))
      // A failed report falls back to the serve-time countdown the page
      // carried, so the round still ends on its own.
      .catch(() => startTick(Number(round.dataset.remaining || 15000)));
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

// A right answer counts the points up, taps the phone and bursts from the
// picked button (the burst itself is markup + CSS); a miss shakes, via CSS.
function celebrate(round) {
  const points = round.querySelector(".reveal-points");
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
  // While the reveal is up, ask for the next round's clip and preload it so
  // the Next form lands on audio that is already fetched. The final reveal
  // has no next round, so it skips the lookup.
  if (round.dataset.last === "1") return;
  fetch(`/play/${round.dataset.game}/prepare`, { method: "POST" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(({ url }) => {
      if (url) {
        const pre = new Audio();
        pre.preload = "auto";
        pre.src = url;
      }
    })
    .catch(() => {});
}

async function send(form, submitter) {
  const response = await fetch(form.action, {
    method: "POST",
    body: new FormData(form, submitter || undefined),
    redirect: "follow",
  });
  const html = await response.text();
  const next = new DOMParser()
    .parseFromString(html, "text/html")
    .getElementById("game");
  if (next === null) {
    location.reload();
    return;
  }
  document.getElementById("game").replaceWith(next);
  wire(next);
}

function wire(root) {
  const round = root.querySelector("#round");
  clearInterval(tickTimer);
  if (!round) return;
  if (round.dataset.phase === "question") {
    wirePlayer(round);
  } else {
    audio?.pause();
    document.body.classList.remove("clip-live");
    if (round.dataset.phase === "reveal") celebrate(round);
  }
  root.querySelectorAll("form[data-solo]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(form, event.submitter);
    });
  });
}

wire(game);
