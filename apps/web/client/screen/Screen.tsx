// The TV's four panels: the lobby with the join code, the round's clock and
// who has answered, the reveal with each player's points, and the final
// standings. The layout comes from the Claude Design file "Earshot Room".
import { For, Repeat, Show, createEffect, createSignal } from "solid-js";
import type { Reveal, RoomState } from "../../src/play/room/protocol";
import { byline, modeNames, scoreFor } from "../../src/play/game/rules";
import { hueOf, waveBars } from "../../src/ui/marks";
import { Mono, Mosaic } from "../ui/marks";
import { Part } from "../ui/part";
import { roundMs, type Screen as ScreenModel } from "./model";

const number = (value: number) => value.toLocaleString("en-US");
const host = (s: RoomState) => s.players.find((p) => p.creator)?.name;
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// "Waiting for Ana to start the game." with the host's monogram.
function WaitLine(props: { s: RoomState; what: string; after?: string }) {
  return (
    <>
      <Show when={host(props.s)}>{(name) => <Mono name={name()} />}</Show>
      <span>
        Waiting for <strong>{host(props.s) ?? "the host"}</strong> to{" "}
        {props.what}.{props.after}
      </span>
    </>
  );
}

function Segments(props: { s: RoomState; current: number }) {
  return (
    <ol class="tv-segs" aria-hidden="true">
      <Repeat count={props.s.rounds}>
        {(i) => (
          <li
            class={
              i < props.current
                ? "is-done"
                : i === props.current
                  ? "is-now"
                  : ""
            }
          />
        )}
      </Repeat>
    </ol>
  );
}

function Lobby(props: { s: RoomState; code: string }) {
  const s = () => props.s;
  return (
    <section class="tv-panel tv-lobby" id="screen-lobby">
      <header class="tv-top">
        <p class="tv-brand">
          <Part name="mark" />
          Earshot
        </p>
        <div class="tv-room">
          <Mosaic seed={s().categorySlug} />
          <p>
            <b>{s().category}</b>
            <span id="screen-mode">
              {modeNames[s().mode]} · {s().rounds} rounds
            </span>
          </p>
        </div>
      </header>
      <div class="tv-lobby-main">
        <div>
          <p class="tv-ask">Join on your phone</p>
          <p class="tv-code" aria-label={`Room code ${props.code}`}>
            <For each={[...props.code]}>{(char) => <span>{char}</span>}</For>
          </p>
          <Part name="join" />
        </div>
        <section class="tv-players">
          <h2>
            Players{" "}
            <small id="screen-seats">
              {s().players.length} of {s().seats}
            </small>
          </h2>
          <ul class="tv-seats" id="screen-roster">
            <For each={s().players} keyed={(p) => p.name}>
              {(p) => (
                <li class={p().connected ? "" : "is-away"}>
                  <Mono name={p().name} />
                  <b>{p().name}</b>
                  <Show when={p().creator || !p().connected}>
                    <span class="tv-tag">{p().creator ? "Host" : "Away"}</span>
                  </Show>
                </li>
              )}
            </For>
            <Repeat count={Math.max(0, s().seats - s().players.length)}>
              {() => (
                <li class="is-open">
                  <span class="tv-seat-empty" />
                  <b>Open seat</b>
                </li>
              )}
            </Repeat>
          </ul>
        </section>
      </div>
      <p class="tv-wait" id="screen-lobby-hint">
        <Show
          when={s().kind === "match"}
          fallback={<WaitLine s={s()} what="start the game" />}
        >
          The game starts once everyone is connected.
        </Show>
      </p>
    </section>
  );
}

function Round(props: { screen: ScreenModel; s: RoomState; hidden: boolean }) {
  const s = () => props.s;
  const left = props.screen.left;
  const playing = () => s().phase === "playing";
  return (
    <section
      class={{
        "tv-panel": true,
        "tv-round": true,
        "is-many": s().players.length > 4,
      }}
      id="screen-game"
      hidden={props.hidden}
    >
      <header class="tv-top">
        <p class="tv-kicker" id="screen-round-title">
          Round {s().round} of {s().rounds}
        </p>
        <Segments s={s()} current={(s().round ?? 1) - 1} />
        <p class="tv-code-pill">{s().code}</p>
      </header>
      <div class="tv-round-main">
        <div
          class="tv-ring"
          id="screen-ring"
          style={{ "--left": String(left() / roundMs) }}
        >
          <p>
            <b id="screen-count">{Math.ceil(left() / 1000)}</b>
            <span id="screen-worth">
              seconds · worth{" "}
              {number(left() > 0 ? scoreFor(roundMs - left()) : 0)}
            </span>
          </p>
        </div>
        <div>
          <h1 class="tv-ask-big">Which song is this?</h1>
          <p class="tv-sub" id="screen-loading">
            {!playing()
              ? "Getting the next song ready…"
              : !s().clip
                ? "Loading the clip…"
                : s().mode === "hard"
                  ? "Type the title on your phone."
                  : "Answer on your phone."}
          </p>
          <div
            class="tv-wave"
            aria-hidden="true"
            ref={(el) => props.screen.wave(el)}
          >
            <For each={waveBars.slice(0, 40)}>
              {(style) => <i style={style} />}
            </For>
          </div>
        </div>
      </div>
      <ul class="tv-answers" id="screen-answers">
        <For each={s().players} keyed={(p) => p.name}>
          {(p) => (
            <li class={p().answered ? "is-done" : ""}>
              <Mono name={p().name} />
              <span>
                <b>{p().name}</b>
                <small>{p().answered ? "Answered" : "Thinking…"}</small>
              </span>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

// "+782" counts up once per revealed round.
function Points(props: { reveal: Reveal; score: number }) {
  const [shown, setShown] = createSignal<number | null>(null);
  createEffect(
    () => props.reveal.number,
    () => {
      const score = props.score;
      if (score <= 0 || reducedMotion()) return;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 500);
        setShown(k < 1 ? Math.round(score * k) : null);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
  );
  return <span class="tv-pts">+{number(shown() ?? props.score)}</span>;
}

function RevealPanel(props: { screen: ScreenModel; s: RoomState; r: Reveal }) {
  const s = () => props.s;
  const r = () => props.r;
  const total = (name: string) =>
    s().players.find((p) => p.name === name)?.score ?? 0;
  const sorted = () => [...r().results].sort((a, b) => b.score - a.score);
  return (
    <section
      class={{
        "tv-panel": true,
        "tv-reveal": true,
        "is-many": r().results.length > 4,
      }}
      id="screen-reveal"
    >
      <header class="tv-top">
        <p class="tv-kicker" id="screen-reveal-title">
          Round {r().number} of {s().rounds}
        </p>
        <Segments s={s()} current={r().number - 1} />
        <p class="tv-next" id="screen-next">
          {r().number >= s().rounds ? "results" : "next round"} in{" "}
          {props.screen.nextIn()} s
        </p>
      </header>
      <div class="tv-reveal-main">
        <div>
          <div
            class="tv-cover"
            id="screen-cover"
            style={{ "--hue": String(hueOf(r().title)) }}
          >
            <Show when={r().cover}>
              {(src) => <img id="screen-reveal-cover" alt="" src={src()} />}
            </Show>
          </div>
          <p class="tv-now">
            <span class="tv-eq" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            Now playing
          </p>
        </div>
        <div>
          <h1 class="tv-song" id="screen-reveal-track">
            {r().title}
          </h1>
          <p class="tv-artist" id="screen-reveal-artist">
            {byline(r())}
          </p>
          <Show when={r().work}>
            {(work) => <p class="tv-work">{work()}</p>}
          </Show>
          <ul class="tv-results" id="screen-reveal-scores">
            <For each={sorted()} keyed={(x) => x.name}>
              {(result) => (
                <li class={result().correct ? "is-right" : ""}>
                  <Mono name={result().name} />
                  <b>{result().name}</b>
                  <Points reveal={r()} score={result().score} />
                  <span class="tv-total">{number(total(result().name))}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Final(props: { s: RoomState }) {
  const s = () => props.s;
  const first = () => s().standings?.[0];
  const rest = () => s().standings?.slice(1) ?? [];
  const tied = () => rest().length > 0 && rest()[0].score === first()?.score;
  return (
    <section
      class={{
        "tv-panel": true,
        "tv-final": true,
        "is-many": rest().length > 4,
      }}
      id="screen-final"
    >
      <header class="tv-top">
        <p class="tv-kicker">Game over · {s().category}</p>
        <p class="tv-code-pill">{s().code}</p>
      </header>
      <div class="tv-final-main">
        <div class="tv-winner">
          <p class="tv-winner-label" id="screen-winner-label">
            {tied() ? "Tied for first" : "Winner"}
          </p>
          <Show when={first()}>
            {(p) => (
              <>
                <p class="tv-winner-who" id="screen-winner">
                  <Mono name={p().name} />
                  <b>{p().name}</b>
                </p>
                <p class="tv-winner-score" id="screen-winner-score">
                  {number(p().score)}
                </p>
                <p class="tv-winner-correct" id="screen-winner-correct">
                  {p().correct}/{s().rounds} correct
                </p>
              </>
            )}
          </Show>
        </div>
        <ol class="tv-standings" id="screen-standings">
          <For each={rest()}>
            {(p, i) => (
              <li>
                <span class="tv-rank">{i() + 2}</span>
                <Mono name={p.name} />
                <span class="tv-who">
                  <b>{p.name}</b>
                  <small>
                    {p.correct}/{s().rounds} correct
                  </small>
                </span>
                <span class="tv-score">{number(p.score)}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
      <p class="tv-wait" id="screen-final-hint">
        <Show
          when={s().kind === "match"}
          fallback={
            <WaitLine
              s={s()}
              what="start a rematch"
              after=" Full results are on every phone."
            />
          }
        >
          Full results are on every phone.
        </Show>
      </p>
    </section>
  );
}

export function Screen(props: { screen: ScreenModel; code: string }) {
  const screen = props.screen;
  const s = () => screen.state();
  const phase = () => (screen.gone() ? "closed" : s()?.phase);
  const inRound = () => phase() === "loading" || phase() === "playing";
  return (
    <>
      <p class="tv-message" id="screen-error" hidden={screen.error() === ""}>
        {screen.error()}
      </p>
      <Show when={s()}>
        {(state) => (
          <>
            <Show when={phase() === "lobby"}>
              <Lobby s={state()} code={props.code} />
            </Show>
            {/* The round panel stays in the page: the wave under it draws
                the playing clip, and a reveal keeps the clip playing. */}
            <Round screen={screen} s={state()} hidden={!inRound()} />
            <Show when={phase() === "reveal" && state().reveal}>
              {(r) => <RevealPanel screen={screen} s={state()} r={r()} />}
            </Show>
            <Show when={phase() === "done"}>
              <Final s={state()} />
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
