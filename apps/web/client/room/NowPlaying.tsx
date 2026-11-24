// The answered song, as the server's nowPlaying draws it
// (src/play/solo/round-page.tsx),
// with its report form. Reports go over fetch so the room socket stays
// connected.
import { Show, createSignal } from "solid-js";
import { byline, linkService } from "../../src/play/game/rules";
import { FlagIcon, OutIcon } from "./icons";
import type { Room } from "./model";

export function NowPlaying(props: { room: Room }) {
  const r = () => props.room.state()?.reveal;
  const [failed, setFailed] = createSignal(false);
  let details!: HTMLDetailsElement;

  function report(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = event.currentTarget;
    fetch(form.action, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams(
        new FormData(form) as unknown as Record<string, string>,
      ),
    })
      .then((response) => {
        if (response.type !== "opaqueredirect" && !response.ok)
          throw new Error(String(response.status));
        form.reset();
        setFailed(false);
        details.open = false;
      })
      .catch(() => setFailed(true));
  }

  return (
    <div class="now">
      <p class="now-label">
        <span class="now-eq" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        Now playing
      </p>
      <span class="cover-tile now-cover">
        <Show when={r()?.cover}>
          {(cover) => <img src={cover()} alt="" width={320} height={320} />}
        </Show>
      </span>
      <div class="now-song">
        <b class="now-title">{r()?.title}</b>
        <span class="now-by">{r() ? byline(r()!) : ""}</span>
        <Show when={r()?.work}>
          {(work) => <span class="now-work">{work()}</span>}
        </Show>
      </div>
      <div class="now-links">
        <Show when={r()?.link}>
          {(link) => (
            <a class="now-link" href={link()}>
              <span class="now-link-long">Listen on</span>
              {linkService(link())}
              <OutIcon />
            </a>
          )}
        </Show>
        <Show when={r()?.track}>
          <details class="report sheet-report" ref={(el) => (details = el)}>
            <summary aria-label="Report this clip">
              <span class="report-flag">
                <FlagIcon />
              </span>
              <span class="report-label">Report</span>
            </summary>
            <form
              class="report-form"
              method="post"
              action="/play/report"
              onSubmit={report}
            >
              <input type="hidden" name="track" value={r()?.track} />
              <input type="hidden" name="title" value={r()?.title} />
              <input type="hidden" name="artist" value={r()?.artist} />
              <input
                type="hidden"
                name="category"
                value={props.room.state()?.categorySlug ?? ""}
              />
              <input type="hidden" name="back" value={location.pathname} />
              <select name="reason" required>
                <option value="wrong_song">Wrong song</option>
                <option value="bad_clip">Bad clip</option>
                <option value="wrong_title">Wrong title</option>
                <option value="other">Other</option>
              </select>
              <button class="pill small" type="submit">
                Send report
              </button>
              <Show when={failed()}>
                <small class="muted report-failed">
                  Could not send the report.
                </small>
              </Show>
            </form>
          </details>
        </Show>
      </div>
    </div>
  );
}
