import { beforeAll, describe, expect, it, vi } from "vitest";

// Drives public/solo.js's keyboard handling against a fake DOM, the same way
// room-js.test.ts drives room.js: elements are stubs and keys are delivered
// through the captured keydown listener.
const baseEl = () => ({
  hidden: true,
  open: false,
  textContent: "",
  value: "",
  className: "",
  src: "",
  href: "",
  volume: 1,
  paused: true,
  dataset: {} as Record<string, string>,
  listeners: {} as Record<string, (event: unknown) => void>,
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners[type] = fn;
  },
  replaceChildren() {},
  append() {},
  classList: {
    add: () => {},
    toggle: () => {},
    remove: () => {},
    contains: () => false,
  },
  click: vi.fn(),
  reset() {},
  play: async () => {},
  pause() {},
  focus: vi.fn(),
  removeAttribute() {},
  setAttribute() {},
  querySelector: null as never,
  querySelectorAll() {
    return [];
  },
});
type Stub = Omit<ReturnType<typeof baseEl>, "querySelector"> & {
  querySelector: (sel: string) => Stub;
};
const makeEl = (): Stub => {
  const stub = baseEl();
  (stub as never as Stub).querySelector = () => makeEl();
  return stub as never as Stub;
};

const els = new Map<string, Stub>();
const el = (id: string, dataset: Record<string, string> = {}) => {
  const stub = makeEl();
  stub.dataset = dataset;
  els.set(id, stub);
  return stub;
};

const round = el("round", { phase: "done" });
const game = el("game");
game.querySelector = (sel: string) =>
  (sel === "#round" ? round : makeEl()) as never;

const choices = [makeEl(), makeEl(), makeEl(), makeEl()];
const continueButton = el("continue-button");
for (const id of [
  "clip",
  "clip-toggle",
  "clip-volume",
  "count-bar",
  "count-left",
  "answer-form",
  "quit-dialog",
])
  el(id);

let keydown: ((event: unknown) => void) | null = null;

vi.stubGlobal("document", {
  getElementById: (id: string) => els.get(id),
  createElement: () => makeEl(),
  addEventListener(type: string, fn: (event: unknown) => void) {
    if (type === "keydown") keydown = fn;
  },
  querySelector: () => null,
  querySelectorAll: (sel: string) =>
    sel === "#answer-form .choice" ? choices : [],
  body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
});
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("matchMedia", () => ({ matches: false }));
vi.stubGlobal(
  "fetch",
  vi.fn(async () => Promise.reject("offline")),
);

const key = (value: string, target: unknown = {}) =>
  keydown?.({
    key: value,
    repeat: false,
    target,
    preventDefault: () => {},
  });

describe("solo.js keyboard", () => {
  beforeAll(async () => {
    // @ts-expect-error plain browser script has no type declarations
    await import("../public/solo.js");
  });

  it("pressing 2 answers the second choice while the question is open", () => {
    round.dataset.phase = "question";
    key("2");
    expect(choices[0].click).not.toHaveBeenCalled();
    expect(choices[1].click).toHaveBeenCalledTimes(1);
    expect(choices[2].click).not.toHaveBeenCalled();
    expect(choices[3].click).not.toHaveBeenCalled();
  });

  it("Enter advances from the sheet", () => {
    round.dataset.phase = "reveal";
    key("Enter");
    expect(continueButton.click).toHaveBeenCalledTimes(1);
  });

  it("number keys do nothing while the sheet is open", () => {
    round.dataset.phase = "reveal";
    vi.clearAllMocks();
    key("2");
    key("4");
    for (const choice of choices) expect(choice.click).not.toHaveBeenCalled();
    expect(continueButton.click).not.toHaveBeenCalled();
  });
});
