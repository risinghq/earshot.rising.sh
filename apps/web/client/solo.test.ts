// Drives the solo page's keyboard against a round's markup.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const choices = () => [
  ...document.querySelectorAll<HTMLButtonElement>("#answer-form .choice"),
];
const round = () => document.getElementById("round")!;
const press = (key: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key }));

beforeAll(async () => {
  // The page starts on the results, so loading it wires no clip or clock.
  document.body.innerHTML = `
    <div id="game">
      <div id="round" data-phase="done">
        <form id="answer-form">
          <button class="choice" type="button">A</button>
          <button class="choice" type="button">B</button>
          <button class="choice" type="button">C</button>
          <button class="choice" type="button">D</button>
        </form>
        <button id="continue-button" type="button">Continue</button>
      </div>
    </div>`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Promise.reject("offline")),
  );
  await import("./solo");
});

const clicks = new Map<Element, ReturnType<typeof vi.fn>>();
beforeEach(() => {
  clicks.clear();
  for (const el of [
    ...choices(),
    document.getElementById("continue-button")!,
  ]) {
    const click = vi.fn();
    el.addEventListener("click", click);
    clicks.set(el, click);
  }
});
const clicked = (el: Element) => clicks.get(el)!.mock.calls.length;

describe("solo keyboard", () => {
  it("pressing 2 answers the second choice while the question is open", () => {
    round().dataset.phase = "question";
    press("2");
    expect(choices().map(clicked)).toEqual([0, 1, 0, 0]);
  });

  it("Enter advances from the sheet", () => {
    round().dataset.phase = "reveal";
    press("Enter");
    expect(clicked(document.getElementById("continue-button")!)).toBe(1);
  });

  it("number keys do nothing while the sheet is open", () => {
    round().dataset.phase = "reveal";
    press("2");
    press("4");
    expect(choices().map(clicked)).toEqual([0, 0, 0, 0]);
    expect(clicked(document.getElementById("continue-button")!)).toBe(0);
  });
});
