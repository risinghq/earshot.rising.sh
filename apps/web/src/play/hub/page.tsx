import { type Child } from "hono/jsx";
import { Page } from "../../ui/shell";
import { EmptyState } from "../../ui/empty";
import { playIcon, soundMark } from "../../ui/person";
import { type Category } from "../catalog/catalog";
import { forYouSlug } from "../catalog/foryou";
import { tileCovers, type TileFacts } from "./hub";
import { eraLabel, eraName, erasCount, isGeneration } from "../catalog/eras";
import { roundSeconds } from "../game/game";
import { type ClipKind } from "../game/clip";
import { defaultMode, type Mode } from "../game/rules";
import { type SignedInUser } from "../../account/auth";

const modeHints: Record<Mode, string> = {
  easy: "Song + artist",
  normal: "Title only",
  hard: "Type it",
};

export type PlayWho = "solo" | "room";

const whoActions: Record<PlayWho, string> = {
  solo: "/play",
  room: "/play/room",
};

// The hub offers the two shown modes; ?mode=hard still reaches the tiles.
const hubModes = ["easy", "normal"] as const satisfies readonly Mode[];

// Four covers make a mosaic; fewer show the first one whole, and none shows
// the mark on a tint.
function genreArt(covers: string[]) {
  if (covers.length === 0)
    return <span class="genre-art is-blank">{soundMark}</span>;
  const shown = covers.length >= tileCovers ? covers : covers.slice(0, 1);
  return (
    <span class={shown.length === 1 ? "genre-art is-single" : "genre-art"}>
      {shown.map((src) => (
        <img
          src={src}
          alt=""
          width="120"
          height="120"
          loading="lazy"
          decoding="async"
        />
      ))}
    </span>
  );
}

// A tile starts a game for the chosen "who", or, on the hub opened from a
// room (`/?room=CODE`), sets that room's next category.
type TileTarget = { who: PlayWho } | { room: string };

function tileForm(
  category: Category,
  target: TileTarget,
  mode: Mode,
  clip: ClipKind,
  body: Child,
) {
  const room = "room" in target ? target.room : null;
  return (
    <form
      class="tile"
      key={category.slug}
      method="post"
      action={
        room === null
          ? whoActions[(target as { who: PlayWho }).who]
          : `/play/room/${room}/switch`
      }
      {...(room === null ? {} : { "data-room": room })}
    >
      <input type="hidden" name="category" value={category.slug} />
      <input type="hidden" name="mode" value={mode} />
      {clip === "intro" && <input type="hidden" name="clip" value="intro" />}
      {room !== null && <input type="hidden" name="k" value="" />}
      {body}
    </form>
  );
}

// A genre row starts a game on the whole pool from its art or All; a decade
// chip narrows it. The art repeats All for a larger target, so it stays out of
// the tab order and the accessibility tree.
function genreRow(
  category: Category,
  facts: TileFacts,
  target: TileTarget,
  mode: Mode,
  clip: ClipKind,
) {
  const by = facts.eras.some(isGeneration) ? "generation" : "decade";
  return tileForm(
    category,
    target,
    mode,
    clip,
    <>
      <button
        class="genre-art-button"
        type="submit"
        tabindex={-1}
        aria-hidden="true"
      >
        {genreArt(facts.covers)}
      </button>
      <div class="genre-body">
        <p class="genre-title">
          <b>{category.name}</b>
          {facts.eras.length > 1 && <span>{erasCount(facts.eras)}</span>}
        </p>
        <div
          class="genre-chips"
          data-kind={by === "generation" ? "gen" : undefined}
          role="group"
          aria-label={`${category.name} by ${by}`}
        >
          <button
            class="chip is-all"
            type="submit"
            aria-label={`${category.name}, every ${by}`}
          >
            All
          </button>
          {facts.eras.map((era) => (
            <button
              class="chip"
              type="submit"
              name="era"
              value={era}
              aria-label={`${category.name}, ${eraName(era)}`}
            >
              {eraLabel(era)}
            </button>
          ))}
        </div>
      </div>
    </>,
  );
}

const chartLabel = (category: Category) =>
  category.name.replace(/^Top 50 /, "");

function chartChip(
  category: Category,
  target: TileTarget,
  mode: Mode,
  clip: ClipKind,
  user: SignedInUser | null,
) {
  if (category.feed === "mine" && user === null)
    return (
      <a class="chip is-quiet" href="/auth/github" key={category.slug}>
        {category.name}
      </a>
    );
  return tileForm(
    category,
    target,
    mode,
    clip,
    <button
      class={category.feed === "mine" ? "chip is-quiet" : "chip"}
      type="submit"
    >
      {chartLabel(category)}
    </button>,
  );
}

// The For you card is a solo game on every "who" choice, so the setup script
// leaves its action alone.
function forYouCard(mode: Mode, clip: ClipKind, cold: boolean) {
  return (
    <form class="tile for-you" method="post" action="/play" data-solo>
      <input type="hidden" name="category" value={forYouSlug} />
      <input type="hidden" name="mode" value={mode} />
      {clip === "intro" && <input type="hidden" name="clip" value="intro" />}
      <button type="submit">
        <span class="for-you-text">
          <span class="label">For you</span>
          <span class="for-you-name">Your mix</span>
          <span class="for-you-note">
            {cold
              ? "Learns your taste as you play."
              : "Tracks you know, plus new ones."}
          </span>
        </span>
        <span class="for-you-play">
          {playIcon}
          <span>Play mix</span>
        </span>
      </button>
    </form>
  );
}

// Charts and the player's own plays sit apart from the genres: they have no
// decades and change every week.
const isChart = (category: Category) =>
  category.feed === "mine" || category.slug.startsWith("top-50-");

// Global leads the charts and the player's own plays close them; the
// country charts keep the catalog's order between.
const chartRank = (category: Category) =>
  category.slug === "top-50-global" ? 0 : category.feed === "mine" ? 2 : 1;

const byChartOrder = (a: Category, b: Category) => chartRank(a) - chartRank(b);

export interface HubOptions {
  categories: Category[];
  facts: Record<string, TileFacts>;
  user: SignedInUser | null;
  who?: PlayWho;
  mode?: Mode;
  clip?: ClipKind;
  introSeconds?: number;
  forYouColdStart?: boolean;
  // A room code: the hub picks that room's next category.
  room?: string;
}

export function hubPage({
  categories,
  facts,
  user,
  who = "solo",
  mode = defaultMode,
  clip = "preview",
  introSeconds = 10,
  forYouColdStart = true,
  room,
}: HubOptions) {
  const whoChecked = (value: PlayWho) =>
    who === value ? { checked: true } : {};
  const target: TileTarget = room === undefined ? { who } : { room };
  const genres = categories.filter((category) => !isChart(category));
  const charts = categories.filter(isChart).sort(byChartOrder);
  return Page({
    title: room === undefined ? "Guess the song" : "Next category",
    user,
    nav: "play",
    bodyClass: "hub",
    children: (
      <>
        <div class="hub-hero">
          <div class="hub-intro">
            {room === undefined ? (
              <>
                <h1 class="display">Guess the song.</h1>
                <p class="lede">
                  Ten clips, {roundSeconds} seconds each. The faster you’re
                  right, the more you score.
                </p>
              </>
            ) : (
              <>
                <h1 class="display">Next category.</h1>
                <p class="lede">
                  Pick what room {room} plays next. Everyone stays in the room.{" "}
                  <a href={`/play/room/${room}`}>Back to the room</a>
                </p>
              </>
            )}
            <form
              class="play-setup"
              id="play-setup"
              method="get"
              action="/"
              data-setup
            >
              {room !== undefined && (
                <input type="hidden" name="room" value={room} />
              )}
              <fieldset class="setup-row" hidden={room !== undefined}>
                <legend class="label">Play</legend>
                <div class="segmented">
                  <label>
                    <input
                      type="radio"
                      name="who"
                      value="solo"
                      {...whoChecked("solo")}
                    />
                    Solo
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="who"
                      value="room"
                      {...whoChecked("room")}
                    />
                    Room
                  </label>
                </div>
              </fieldset>
              <fieldset class="setup-row">
                <legend class="label">Show</legend>
                <div class="segmented">
                  {hubModes.map((value) => (
                    <label>
                      <input
                        type="radio"
                        name="mode"
                        value={value}
                        {...(mode === value ? { checked: true } : {})}
                      />
                      {modeHints[value]}
                    </label>
                  ))}
                </div>
              </fieldset>
              {user?.tier === "paid" && (
                <fieldset class="setup-row">
                  <legend class="label">Clip</legend>
                  <div class="segmented">
                    <label>
                      <input
                        type="radio"
                        name="clip"
                        value="preview"
                        {...(clip === "preview" ? { checked: true } : {})}
                      />
                      Middle {roundSeconds} s
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="clip"
                        value="intro"
                        {...(clip === "intro" ? { checked: true } : {})}
                      />
                      First {introSeconds} s
                    </label>
                  </div>
                </fieldset>
              )}
              <noscript>
                <button class="pill" type="submit">
                  Apply
                </button>
              </noscript>
            </form>
          </div>
          {room === undefined && forYouCard(mode, clip, forYouColdStart)}
        </div>
        <div class="hub-lists">
          <section class="hub-section" aria-labelledby="genres-title">
            <div class="hub-section-head">
              <h2 id="genres-title">Genres</h2>
              <p>
                <span class="is-narrow">Tap an era</span>
                <span class="is-wide">Pick an era, or All</span>
              </p>
            </div>
            <div class="genres">
              {genres.map((category) =>
                genreRow(
                  category,
                  facts[category.slug] ?? { eras: [], covers: [] },
                  target,
                  mode,
                  clip,
                ),
              )}
              <p class="genre-more">
                <span class="genre-art" aria-hidden="true" />
                More genres coming
              </p>
            </div>
          </section>
          <section class="hub-section" aria-labelledby="ways-title">
            <div class="hub-section-head">
              <h2 id="ways-title">More ways to play</h2>
            </div>
            <div class="ways">
              {charts.length > 0 && (
                <div class="way">
                  <h3>Top 50 charts</h3>
                  <div class="chips">
                    {charts.map((category) =>
                      chartChip(category, target, mode, clip, user),
                    )}
                  </div>
                </div>
              )}
              <div class="way" hidden={room !== undefined}>
                <h3 id="artist-title">Play an artist</h3>
                <form method="get" action="/play/artists" class="inline-form">
                  <input
                    id="artist-q"
                    name="q"
                    type="search"
                    autocomplete="off"
                    placeholder="Artist name"
                    aria-labelledby="artist-title"
                    required
                  />
                  <button class="pill ink" type="submit">
                    Search
                  </button>
                </form>
                <p class="hint">One artist, or blend two into one game.</p>
              </div>
            </div>
          </section>
        </div>
        <p class="meta hub-note">
          Clips and charts from Deezer, with Apple Music as fallback. Every
          reveal links to the track.
        </p>
      </>
    ),
  });
}

export function feedErrorPage(
  name: string,
  user: SignedInUser | null,
  back = "/",
) {
  return Page({
    title: "Category unavailable",
    user,
    children: (
      <EmptyState
        title={`${name} is not available right now`}
        body="The music feed did not answer. Pick another category or try again in a moment."
        action={{ href: back, label: "Back to categories" }}
        heading="h1"
      />
    ),
  });
}
