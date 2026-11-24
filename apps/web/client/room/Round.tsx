// A round on this phone: the stage, the choices (or the typed answer in
// hard mode) and one card that follows the round: who answered, then at
// the reveal what each player scored, under this player's verdict.
import { For, Repeat, Show, createEffect, createSignal } from "solid-js";
import type { Reveal, RoomState } from "../../src/play/room/protocol";
import { maxChoices, type Choice } from "../../src/play/game/rules";
import { CheckIcon, CrossIcon } from "./icons";
import type { Room } from "./model";
import { Mono } from "../ui/marks";
import { ChoiceLabel } from "./parts";
import { Stage } from "./Stage";
import { mineOf, placeLine, revealNote, verdictOf, verdictWords } from "./text";

const skeleton: Choice = { title: "…", artist: "…" };
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

// Four buttons keep their place from the skeleton to the reveal, so
// nothing moves when they fill or turn.
function Choices(props: { room: Room; reveal: Reveal | undefined }) {
  const room = props.room;
  const s = () => room.state()!;
  const open = () => room.opened() !== 0 && room.opened() === room.shownRound();
  const choiceAt = (i: number) =>
    props.reveal
      ? props.reveal.choices[i]
      : open()
        ? s().choices?.[i]
        : undefined;
  const mine = () => (props.reveal ? mineOf(s(), props.reveal) : undefined);

  function Button(i: number) {
    const choice = () => choiceAt(i);
    const right = () =>
      props.reveal !== undefined && choice()?.title === props.reveal.title;
    const yours = () =>
      props.reveal !== undefined && choice()?.title === mine()?.answer;
    const picked = () =>
      props.reveal === undefined &&
      choice() !== undefined &&
      choice()!.title === room.answer();
    return (
      <button
        type="button"
        class={{
          choice: true,
          "is-skeleton": choice() === undefined,
          "is-picked": picked(),
          "is-right": right(),
          "is-wrong": !right() && yours(),
        }}
        disabled={
          props.reveal !== undefined ||
          choice() === undefined ||
          room.answered()
        }
        onClick={() => {
          const title = choice()?.title;
          if (title !== undefined) room.pick(title);
        }}
      >
        <Show
          when={right() || yours()}
          fallback={
            <span class="choice-key" aria-hidden="true">
              {i + 1}
            </span>
          }
        >
          <Show when={right()} fallback={<CrossIcon />}>
            <CheckIcon />
          </Show>
        </Show>
        <ChoiceLabel choice={choice() ?? skeleton} />
        <Show when={picked()}>
          <span class="choice-lock">Locked in</span>
        </Show>
        <Show when={yours()}>
          <span class="choice-you">
            You<span class="is-wide">r pick</span>
          </span>
        </Show>
        <Show when={right() && mine()?.correct && !reducedMotion()}>
          <span class="burst" aria-hidden="true">
            <Repeat count={8}>{() => <i />}</Repeat>
          </span>
        </Show>
      </button>
    );
  }

  return (
    <div
      class={{
        choices: true,
        "reveal-choices": props.reveal !== undefined,
        "is-locked": props.reveal === undefined && room.answered(),
      }}
      id="choices"
    >
      <Repeat count={s().mode === "hard" ? 0 : maxChoices}>{Button}</Repeat>
    </div>
  );
}

function Typed(props: { room: Room; reveal: Reveal | undefined }) {
  const room = props.room;
  let input!: HTMLInputElement;
  const shown = () =>
    room.state()?.mode === "hard" &&
    props.reveal === undefined &&
    room.answersOpen() &&
    !room.answered();
  createEffect(shown, (on) => {
    if (on) input.focus({ preventScroll: true });
  });
  const mine = () =>
    props.reveal ? mineOf(room.state()!, props.reveal) : undefined;
  return (
    <>
      <form
        id="typed-form"
        class="guess"
        hidden={!shown()}
        onSubmit={(event) => {
          event.preventDefault();
          room.type(input.value);
          input.value = "";
        }}
      >
        <div class="form-row">
          <label for="typed-answer">Song title</label>
          <input
            id="typed-answer"
            name="answer"
            type="text"
            autocomplete="off"
            ref={(el) => (input = el)}
          />
        </div>
        <div>
          <button class="pill primary" type="submit">
            Guess
          </button>
        </div>
      </form>
      <dl
        class="reveal-typed"
        id="typed-verdict"
        hidden={room.state()?.mode !== "hard" || props.reveal === undefined}
      >
        <div>
          <dt>You typed</dt>
          <dd id="typed-given" class={mine()?.correct ? "good" : ""}>
            {mine()?.answer || "Nothing"}
          </dd>
        </div>
      </dl>
    </>
  );
}

type ChipState = "answered" | "waiting" | "right" | "wrong" | "none";

function chipOf(s: RoomState, name: string, answered: boolean, r?: Reveal) {
  if (!r)
    return answered
      ? { state: "answered" as ChipState, line: "Answered" }
      : { state: "waiting" as ChipState, line: "Thinking…" };
  const result = r.results.find((x) => x.name === name);
  if (result?.correct)
    return { state: "right" as ChipState, line: `+${result.score}` };
  if (result?.answer) return { state: "wrong" as ChipState, line: "× +0" };
  return { state: "none" as ChipState, line: "— +0" };
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
  return (
    <b class="v-pts" id="verdict-points">
      +{shown() ?? props.score}
    </b>
  );
}

function Slot(props: { room: Room; reveal: Reveal | undefined }) {
  const s = () => props.room.state()!;
  const r = () => props.reveal;
  const got = () => r()?.results.filter((x) => x.correct).length ?? 0;
  const done = () => s().players.filter((p) => p.answered).length;
  return (
    <div
      class="room-slot"
      id="room-slot"
      data-v={r() ? verdictOf(s(), r()!) : undefined}
    >
      <p class="room-verdict" id="room-verdict" aria-live="polite">
        <Show when={r()}>
          {(reveal) => (
            <>
              <b class="v-word" id="verdict-word">
                {verdictWords[verdictOf(s(), reveal())]}
              </b>
              <Points
                reveal={reveal()}
                score={mineOf(s(), reveal())?.score ?? 0}
              />
              <span class="v-place" id="verdict-place">
                {placeLine(s())}
              </span>
            </>
          )}
        </Show>
      </p>
      <div class="room-slot-card">
        <p class="room-slot-head">
          <span id="slot-title">{r() ? "This round" : "Answered"}</span>
          <b id="answered-count">
            {r()
              ? `${got()} of ${s().players.length} got it`
              : `${done()} of ${s().players.length}`}
          </b>
        </p>
        <ul class="room-chips" id="round-chips" aria-label="Players">
          <For each={s().players} keyed={(p) => p.name}>
            {(p) => {
              const chip = () => chipOf(s(), p().name, p().answered, r());
              const you = () => p().name === s().you.name;
              return (
                <li
                  class={{ "room-chip": true, "is-you": you() }}
                  data-s={chip().state}
                >
                  <Mono name={p().name} />
                  <span class="c-text">
                    <b>{you() ? "You" : p().name}</b>
                    <small class="c-pts">{chip().line}</small>
                  </span>
                </li>
              );
            }}
          </For>
        </ul>
        <p class="room-note" id="slot-note">
          {r()
            ? revealNote(s(), r()!)
            : "The round ends early once everyone has answered."}
        </p>
      </div>
    </div>
  );
}

export function Round(props: { room: Room; hidden: boolean }) {
  const room = props.room;
  const reveal = () =>
    room.stagePhase() === "reveal" ? room.state()?.reveal : undefined;
  return (
    <div id="round" data-phase={room.stagePhase()} hidden={props.hidden}>
      <Stage room={room} />
      <h1 class="round-title">Which song is this?</h1>
      <Show when={room.state()?.you.name}>
        <Choices room={room} reveal={reveal()} />
        <Typed room={room} reveal={reveal()} />
        <Slot room={room} reveal={reveal()} />
      </Show>
    </div>
  );
}
