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

let tickTimer = null;

function setIcon(playing) {
  const toggle = $("clip-toggle");
  if (!toggle) return;
  show(toggle.querySelector(".i-play"), !playing);
  show(toggle.querySelector(".i-pause"), playing);
}

function wirePlayer(round) {
  audio = round.querySelector("#clip");
  const toggle = $("clip-toggle");
  const bar = $("count-bar");
  const left = $("count-left");
  const form = $("answer-form");
  if (!toggle || !bar || !left) return;
  audio.removeAttribute("controls");
  show(toggle, true);
  audio.src = round.dataset.src;
  const start = () => {
    audio.play().then(
      () => {
        setIcon(true);
        toggle.classList.remove("needs-click");
      },
      () => {
        setIcon(false);
        toggle.classList.add("needs-click");
      },
    );
  };
  toggle.onclick = () => {
    if (audio.paused) start();
    else {
      audio.pause();
      setIcon(false);
    }
  };
  audio.onended = () => setIcon(false);
  start();
  let deadline = performance.now() + Number(round.dataset.remaining || 0);
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
    setIcon(false);
  }
  root.querySelectorAll("form[data-solo]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      send(form, event.submitter);
    });
  });
}

wire(game);
