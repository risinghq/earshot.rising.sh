const roomKey = (code: string) => `quiz-room-${code}`;
const tileActions = { solo: "/play", room: "/play/room" } as const;

function localZone(scope: ParentNode) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  scope
    .querySelectorAll<HTMLSelectElement>("select[data-local-zone]")
    .forEach((select) => {
      if (select.dataset.stored !== undefined) return;
      if ([...select.options].some((option) => option.value === zone))
        select.value = zone;
    });
}

// The server checks the typed name again. This check only saves a round trip.
function arm(input: HTMLInputElement) {
  const button = document.getElementById(input.dataset.arms ?? "");
  if (button instanceof HTMLButtonElement)
    button.disabled = input.value.trim() !== input.dataset.name;
}

function fold(scope: ParentNode) {
  scope.querySelectorAll<HTMLElement>("[data-fold]").forEach((list) => {
    const more = list.querySelector<HTMLElement>("[data-unfold]");
    if (!more) return;
    list.classList.add("is-folded");
    more.hidden = false;
  });
}

export function enhance(scope: ParentNode) {
  localZone(scope);
  scope
    .querySelectorAll<HTMLInputElement>("input[data-arms]")
    .forEach((input) => arm(input));
  fold(scope);
}

function followSetup(setup: HTMLFormElement) {
  const data = new FormData(setup);
  const who = data.get("who");
  const mode = data.get("mode");
  document.querySelectorAll<HTMLFormElement>("form.tile").forEach((tile) => {
    if (
      (who === "solo" || who === "room") &&
      tile.dataset.solo === undefined &&
      tile.dataset.room === undefined
    )
      tile.action = tileActions[who];
    const field = tile.elements.namedItem("mode");
    if (field instanceof HTMLInputElement && typeof mode === "string")
      field.value = mode;
  });
}

async function exportAll(link: HTMLAnchorElement) {
  const label = link.textContent;
  link.textContent = "Exporting…";
  const parts: string[] = [];
  let url: string | null = link.href;
  while (url !== null) {
    const page: Response = await fetch(url);
    parts.push(await page.text());
    const next = /<([^>]+)>;\s*rel="next"/.exec(page.headers.get("link") ?? "");
    url = next ? new URL(next[1], url).href : null;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(
    new Blob(parts, { type: "application/x-ndjson" }),
  );
  anchor.download = `music-stats-${link.dataset.exportAll}.ndjson`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  link.textContent = label;
}

export function listen(root: Document) {
  // This listener captures, so it runs before the data-inline submit handler.
  // A refused confirm must stop that fetch too.
  root.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const question = form.dataset.confirm;
      if (question !== undefined && !confirm(question)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // The room refuses a switch without the creator's key. Only the room
      // page's localStorage holds that key.
      const code = form.dataset.room;
      const key = form.elements.namedItem("k");
      if (code && key instanceof HTMLInputElement)
        key.value = localStorage.getItem(roomKey(code)) ?? "";
    },
    true,
  );
  root.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.arms)
      arm(event.target);
  });
  root.addEventListener("change", (event) => {
    const setup = (event.target as Element | null)?.closest?.(
      "form[data-setup]",
    );
    if (setup instanceof HTMLFormElement) followSetup(setup);
  });
  root.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const more = target?.closest?.<HTMLElement>("[data-unfold]");
    if (more) {
      more.closest("[data-fold]")?.classList.remove("is-folded");
      more.remove();
      return;
    }
    const link = target?.closest?.("a[data-export-all]");
    if (link instanceof HTMLAnchorElement) {
      event.preventDefault();
      void exportAll(link);
    }
  });
}
