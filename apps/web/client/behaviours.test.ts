import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { enhance, listen } from "./behaviours";

// Stands in for the page's later submit handlers and for the browser's post.
const posted = vi.fn();

beforeAll(() => {
  listen(document);
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    posted(event.target);
  });
});

afterEach(() => {
  posted.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const show = (html: string) => {
  document.body.innerHTML = html;
  enhance(document);
};
const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("data-confirm", () => {
  const form = `<form id="ban" data-confirm="Ban this track?"><button>Ban</button></form>`;

  it("stops the post when the question is refused", () => {
    show(form);
    vi.stubGlobal("confirm", () => false);
    byId<HTMLFormElement>("ban").requestSubmit();
    expect(posted).not.toHaveBeenCalled();
  });

  it("posts when the question is accepted", () => {
    show(form);
    vi.stubGlobal("confirm", () => true);
    byId<HTMLFormElement>("ban").requestSubmit();
    expect(posted).toHaveBeenCalledOnce();
  });
});

describe("data-arms", () => {
  it("enables the button only while the input holds the name", () => {
    show(`
      <input id="confirm" data-arms="delete" data-name="ada">
      <button id="delete">Delete account</button>`);
    const button = byId<HTMLButtonElement>("delete");
    const input = byId<HTMLInputElement>("confirm");
    expect(button.disabled).toBe(true);
    type(input, " ada ");
    expect(button.disabled).toBe(false);
    type(input, "ad");
    expect(button.disabled).toBe(true);
  });
});

describe("data-local-zone", () => {
  const select = (stored = "") => `
    <select id="tz" data-local-zone ${stored}>
      <option value="UTC" selected>UTC</option>
      <option value="America/Lima">America/Lima</option>
    </select>`;

  it("picks the browser's zone when none is stored", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "America/Lima",
    } as Intl.ResolvedDateTimeFormatOptions);
    show(select());
    expect(byId<HTMLSelectElement>("tz").value).toBe("America/Lima");
  });

  it("keeps a stored zone", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "America/Lima",
    } as Intl.ResolvedDateTimeFormatOptions);
    show(select('data-stored="UTC"'));
    expect(byId<HTMLSelectElement>("tz").value).toBe("UTC");
  });
});

describe("data-fold", () => {
  it("folds the list until its button unfolds it for good", () => {
    show(`
      <section id="list" data-fold>
        <ol><li>one</li></ol>
        <button id="more" data-unfold hidden>Show all</button>
      </section>`);
    const list = byId("list");
    expect(list.classList.contains("is-folded")).toBe(true);
    expect(byId("more").hidden).toBe(false);
    byId("more").click();
    expect(list.classList.contains("is-folded")).toBe(false);
    expect(document.getElementById("more")).toBeNull();
  });

  it("leaves a short list without a button unfolded", () => {
    show(`<section id="list" data-fold><ol><li>one</li></ol></section>`);
    expect(byId("list").classList.contains("is-folded")).toBe(false);
  });
});

describe("data-setup", () => {
  const hub = `
    <form id="setup" data-setup>
      <input type="radio" name="who" value="solo" checked>
      <input type="radio" name="who" value="room" id="room">
      <input type="radio" name="mode" value="easy" checked>
      <input type="radio" name="mode" value="normal" id="normal">
    </form>
    <form class="tile" id="genre" action="/play"><input type="hidden" name="mode" value="easy"></form>
    <form class="tile" id="foryou" action="/play" data-solo><input type="hidden" name="mode" value="easy"></form>`;
  const pick = (id: string) => {
    byId<HTMLInputElement>(id).checked = true;
    byId(id).dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("points the tiles at a room and the chosen mode", () => {
    show(hub);
    pick("room");
    pick("normal");
    const genre = byId<HTMLFormElement>("genre");
    expect(new URL(genre.action).pathname).toBe("/play/room");
    expect(new FormData(genre).get("mode")).toBe("normal");
  });

  it("keeps a solo-only tile on solo", () => {
    show(hub);
    pick("room");
    const foryou = byId<HTMLFormElement>("foryou");
    expect(new URL(foryou.action).pathname).toBe("/play");
  });
});

describe("data-room", () => {
  it("sends the creator's key with a room tile", () => {
    localStorage.setItem("quiz-room-ABCD", "secret");
    show(
      `<form id="tile" data-room="ABCD"><input type="hidden" name="k"></form>`,
    );
    byId<HTMLFormElement>("tile").requestSubmit();
    expect(new FormData(posted.mock.calls[0][0]).get("k")).toBe("secret");
  });
});

describe("data-export-all", () => {
  it("saves every page the Link header chains as one file", async () => {
    const pages: Record<string, Response> = {
      "/settings/export": new Response('{"n":1}\n', {
        headers: { link: '</settings/export?after=1>; rel="next"' },
      }),
      "/settings/export?after=1": new Response('{"n":2}\n'),
    };
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      return pages[url.pathname + url.search];
    });
    let saved: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved = blob as Blob;
      return "blob:export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let downloaded!: (name: string) => void;
    const download = new Promise<string>((resolve) => {
      downloaded = resolve;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded(this.download);
    });
    show(
      `<a id="export" href="/settings/export" data-export-all="ada">Download</a>`,
    );
    const press = new MouseEvent("click", { bubbles: true, cancelable: true });
    byId("export").dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(await download).toBe("music-stats-ada.ndjson");
    expect(await saved!.text()).toBe('{"n":1}\n{"n":2}\n');
  });
});
