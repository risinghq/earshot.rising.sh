// The final screen: this player's score and place, the standings (people),
// the rounds (songs, with who got each one) and the category's board.
// Neither list repeats the other. Next game is a step of the results, not a
// sheet: choosing takes the room a minute, and everyone sees the same list.
import { For, Show, createEffect, flush } from "solid-js";
import type { RoomState } from "../../src/play/protocol";
import { byline, modeNames } from "../../src/play/rules";
import { hueOf } from "../../src/ui/marks";
import { BackIcon, CrossIcon } from "./icons";
import type { Room } from "./model";
import { Mono, MonoStack, Part, Tag, WaitRow } from "./parts";
import {
  doneSummary,
  gotItLine,
  host,
  kindOf,
  number,
  suggestionCount,
  suggestionLine,
  topPick,
} from "./text";

export type OpenPicker = (tab: "genre" | "artist") => void;

function Next(props: { room: Room; s: RoomState; openPicker: OpenPicker }) {
  const room = props.room;
  const s = () => props.s;
  const creator = () => s().you.creator;
  const list = () => s().suggestions ?? [];
  const top = () => topPick(s());
  // A player's own suggestion sits in its card; picking again replaces it.
  const mine = () => list().find((x) => x.mine);
  return (
    <section
      class="room-next"
      id="next-panel"
      aria-labelledby="next-title"
      hidden={room.doneStep() !== "next"}
    >
      <button
        class="room-back"
        id="next-back"
        type="button"
        onClick={() => {
          room.setDoneStep("results");
          flush();
          document.getElementById("next-open")?.focus();
        }}
      >
        <BackIcon />
        Results
      </button>
      <div class="room-next-head">
        <h1 id="next-title" tabindex={-1}>
          Next game
        </h1>
        <p id="next-sub">
          {creator()
            ? "Everyone suggests and votes. You play the pick."
            : "Suggest a genre or an artist, and vote. The host plays the pick."}
        </p>
      </div>
      <section class="room-sugs" aria-labelledby="sugs-title">
        <div class="room-sugs-head">
          <h2 id="sugs-title">Suggestions</h2>
          <small id="up-next-live">{suggestionCount(s())}</small>
        </div>
        <p class="room-sug-empty" id="up-next-empty" hidden={list().length > 0}>
          Nothing yet. Suggest a genre or an artist, and everyone votes.
        </p>
        <ol class="room-sug-list" id="up-next-list">
          <For each={list()} keyed={(x) => x.id}>
            {(x) => (
              <li
                class="room-sug"
                data-top={top()?.id === x().id ? "" : undefined}
              >
                <span class="room-sug-tile">{[...x().name][0] ?? "?"}</span>
                <span class="room-sug-text">
                  <b>{x().name}</b>
                  <small>{suggestionLine(x())}</small>
                </span>
                <button
                  class="btn-vote"
                  type="button"
                  aria-pressed={x().voted ? "true" : "false"}
                  aria-label={`Vote for ${x().name}, ${x().votes} ${x().votes === 1 ? "vote" : "votes"}`}
                  onClick={() => room.vote(x().id)}
                >
                  ▲ {x().votes}
                </button>
                <Show when={creator()}>
                  <button
                    class="btn-play-this"
                    type="button"
                    onClick={() => room.switchTo(x().slug, x().mode, true)}
                  >
                    Play this
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </section>
      <div
        class="room-mine"
        id="mine-card"
        hidden={mine() === undefined || creator()}
      >
        <p>
          <small>Your suggestion</small>
          <b id="mine-name">{mine()?.name}</b>
        </p>
        <button
          class="room-mine-change"
          id="mine-change"
          type="button"
          onClick={() =>
            props.openPicker(
              mine() && kindOf(mine()!.slug) === "Artist" ? "artist" : "genre",
            )
          }
        >
          Change
        </button>
      </div>
      <div
        class="room-mine-add"
        id="mine-add"
        hidden={mine() !== undefined && !creator()}
      >
        <button
          class="btn"
          type="button"
          data-pick="genre"
          onClick={() => props.openPicker("genre")}
        >
          + Genre
        </button>
        <button
          class="btn"
          type="button"
          data-pick="artist"
          onClick={() => props.openPicker("artist")}
        >
          + Artist
        </button>
      </div>
      <div class="results-actions room-actions room-next-actions">
        <button
          class="btn is-lg"
          id="next-rematch"
          type="button"
          hidden={!creator()}
          onClick={() => room.start()}
        >
          Rematch
        </button>
        <button
          class="btn is-primary is-lg"
          id="play-top"
          type="button"
          hidden={!creator() || top() === undefined}
          onClick={() => {
            const pick = top();
            if (pick) room.switchTo(pick.slug, pick.mode, true);
          }}
        >
          Play {top()?.name} <kbd class="room-kbd">Enter</kbd>
        </button>
        <WaitRow
          id="next-wait"
          hidden={creator()}
          host={host(s())}
          what="pick the next game"
        />
      </div>
    </section>
  );
}

function Standings(props: { s: RoomState }) {
  const s = () => props.s;
  const standings = () => s().standings ?? [];
  const creators = () =>
    new Set(
      s()
        .players.filter((p) => p.creator)
        .map((p) => p.name),
    );
  return (
    <ol class="board-rows" id="done-standings">
      <For each={standings()}>
        {(p) => (
          <li class={p.name === s().you.name ? "is-you" : ""}>
            <span class="board-rank">
              {1 + standings().filter((q) => q.score > p.score).length}
            </span>
            <Mono name={p.name} />
            <span class="room-person">
              <b>
                {p.name}
                <Show when={p.name === s().you.name}>
                  <Tag kind="you">You</Tag>
                </Show>
                <Show when={creators().has(p.name)}>
                  <Tag kind="host">Host</Tag>
                </Show>
              </b>
              <small>
                {p.correct ?? 0}/{s().rounds} correct
              </small>
            </span>
            <span class="board-score">{number(p.score)}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

function Rounds(props: { s: RoomState; many: boolean }) {
  const s = () => props.s;
  return (
    <ol class="round-rows" id="done-rounds">
      <For each={s().history ?? []}>
        {(h) => {
          const yours = h.results.find((x) => x.name === s().you.name);
          const got = h.results.filter((x) => x.correct).map((x) => x.name);
          return (
            <li>
              <span class="round-i" aria-hidden="true">
                {h.number}
              </span>
              <span
                class="cover-tile"
                style={{ "--hue": String(hueOf(h.title)) }}
              >
                <Show when={h.cover}>
                  <img
                    src={h.cover!}
                    alt=""
                    width={52}
                    height={52}
                    loading="lazy"
                  />
                </Show>
              </span>
              <span class="round-song">
                <b>{h.title}</b>
                <small>
                  {byline(h)}
                  <Show when={!yours?.correct}>
                    {" · "}
                    <span class="round-said">
                      {yours?.answer ? `you said ${yours.answer}` : "no answer"}
                    </span>
                  </Show>
                </small>
              </span>
              <Show when={props.many}>
                <span class="round-who">
                  <MonoStack names={got} />
                  <span>{gotItLine(got, h.results.length, s().you.name)}</span>
                </span>
              </Show>
              <span
                class={`round-points ${yours?.correct ? "is-right" : "is-wrong"}`}
              >
                <Show when={yours?.correct} fallback={<CrossIcon />}>
                  +{yours!.score}
                </Show>
              </span>
            </li>
          );
        }}
      </For>
    </ol>
  );
}

function Board(props: { s: RoomState; days: string }) {
  const s = () => props.s;
  const board = () => (s().board ?? []).slice(0, 5);
  return (
    <section
      class="results-card room-board"
      id="done-board-card"
      hidden={board().length === 0 && s().you.user}
    >
      <h2>
        Top scores{" "}
        <small id="done-board-note">
          {s().category} · last {props.days} days
        </small>
      </h2>
      <ol class="board-rows" id="done-board" hidden={board().length === 0}>
        <For each={board()}>
          {(entry, index) => (
            <li
              class={
                s().you.user && entry.name === s().you.name ? "is-you" : ""
              }
            >
              <span class="board-rank">{index() + 1}</span>
              <Mono name={entry.name} size={32} />
              <span class="board-name">
                <a href={`/u/${encodeURIComponent(entry.name)}`}>
                  {entry.name}
                </a>
              </span>
              <span class="board-score">{number(entry.score)}</span>
            </li>
          )}
        </For>
      </ol>
      <Show when={!s().you.user}>
        <Part name="board-foot" />
      </Show>
    </section>
  );
}

export function Done(props: {
  room: Room;
  hidden: boolean;
  boardDays: string;
  openPicker: OpenPicker;
}) {
  const room = props.room;
  const s = () => {
    const state = room.state();
    return state?.phase === "done" && state.you.name ? state : null;
  };
  let save: HTMLElement | undefined;
  createEffect(
    () => {
      const state = s();
      if (!state) return null;
      const sum = doneSummary(state);
      return { title: sum.save, shown: !state.you.user && sum.score > 0 };
    },
    (card) => {
      if (!save || !card) return;
      const title = save.querySelector("[data-save-title]");
      if (title) title.textContent = card.title;
      save.hidden = !card.shown;
    },
  );

  return (
    <div
      class="results room-done"
      id="done-panel"
      data-step={room.doneStep()}
      hidden={props.hidden}
    >
      <Show when={s()}>
        {(state) => {
          const sum = () => doneSummary(state());
          const creator = () => state().you.creator;
          return (
            <>
              <div class="results-main">
                <section class="score-card" aria-labelledby="score-label">
                  <div class="score-top">
                    <h1 class="score-label" id="score-label">
                      Game over
                    </h1>
                    <span
                      class="score-best"
                      id="score-best"
                      hidden={!sum().many}
                    >
                      {sum().place}
                    </span>
                  </div>
                  <p class="score-n" id="score-n">
                    {number(sum().score)}
                  </p>
                  <p class="score-rank" id="score-rank">
                    {sum().rank}
                  </p>
                  <ol
                    class="score-pips"
                    id="score-pips"
                    aria-label={sum().pips}
                  >
                    <For each={state().you.marks}>
                      {(right) => <li class={right ? "is-right" : ""} />}
                    </For>
                  </ol>
                </section>
                <dl class="results-stats" id="done-stats">
                  <For each={sum().stats}>
                    {([label, value]) => (
                      <div>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    )}
                  </For>
                </dl>
                <div class="results-actions room-actions room-done-actions">
                  <button
                    class="btn is-primary is-lg room-two-line"
                    id="rematch-button"
                    type="button"
                    hidden={!creator()}
                    onClick={() => room.start()}
                  >
                    <span>
                      Rematch <kbd class="room-kbd">Enter</kbd>
                    </span>
                    <small id="rematch-sub">
                      {state().category} · {modeNames[state().mode]}
                    </small>
                  </button>
                  <button
                    class="btn is-lg room-two-line"
                    id="next-open"
                    type="button"
                    onClick={() => {
                      room.setDoneStep("next");
                      flush();
                      document.getElementById("next-title")?.focus();
                    }}
                  >
                    <span>Next game →</span>
                    <small id="next-open-sub">{suggestionCount(state())}</small>
                  </button>
                  <WaitRow
                    id="done-wait"
                    hidden={creator()}
                    host={host(state())}
                    what="pick the next game"
                  />
                </div>
                {/* A guest who did well is offered the account that keeps
                    the game; the server moves this seat into it when the
                    page comes back signed in. */}
                <Part name="save" ref={(el) => (save = el)} />
              </div>
              <Next room={room} s={state()} openPicker={props.openPicker} />
              <section class="results-card room-standings">
                <h2>
                  Standings <small>this room</small>
                </h2>
                <Standings s={state()} />
              </section>
              <section class="results-card results-rounds">
                <h2>
                  Rounds <small>who got each song</small>
                </h2>
                <Rounds s={state()} many={sum().many} />
              </section>
              <Board s={state()} days={props.boardDays} />
            </>
          );
        }}
      </Show>
    </div>
  );
}
