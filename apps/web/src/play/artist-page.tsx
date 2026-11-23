import { Section } from "../ui/section";
import { Page } from "../ui/shell";
import { type ArtistProfile, type Category } from "./catalog";
import { type CategoryBoardEntry, categoryBoardDays } from "./results";
import { roundSeconds, roundsPerGame } from "./game";
import { matchWaitMs } from "./room";
import { defaultMode, modeNames, modes, type Mode } from "./rules";
import { type SignedInUser } from "../auth";
import { type ArtistHit, type Candidate } from "./sources";
import { number } from "../ui/format";
import { CategoryBoard } from "./board-page";

type Picked = { id: number; name: string } | null;

const searchIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
    <circle
      cx="7.5"
      cy="7.5"
      r="5.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
    <path
      d="M11.5 11.5L16 16"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    />
  </svg>
);

function searchHref(query: string, picked: Picked) {
  const params = new URLSearchParams({ q: query });
  if (picked !== null) {
    params.set("with", String(picked.id));
    params.set("n", picked.name);
  }
  return `/play/artists?${params}`;
}

// While blending, a hit opens the blend with the artist already picked; the
// picked artist itself, or any hit outside a blend, opens its own page.
function hitHref(hit: ArtistHit, picked: Picked) {
  return picked === null || picked.id === hit.id
    ? `/play/artist/${hit.id}`
    : `/play/artist/${picked.id}-${hit.id}`;
}

function artistArt(hit: ArtistHit, className: string, size: number) {
  return hit.picture === null ? (
    <span class={`${className} is-empty`} aria-hidden="true">
      {hit.name.slice(0, 1)}
    </span>
  ) : (
    <img
      class={className}
      src={hit.picture}
      alt=""
      width={size}
      height={size}
      loading="lazy"
    />
  );
}

function topHit(hit: ArtistHit, picked: Picked, query: string) {
  const blending = picked !== null && picked.id !== hit.id;
  return (
    <div class="artist-top-card">
      {artistArt(hit, "artist-top-art", 250)}
      <div class="artist-top-body">
        <b>{hit.name}</b>
        <p class="meta">
          {number(hit.fans)} fans · {roundsPerGame} rounds of top tracks
        </p>
        <div class="artist-top-actions">
          <a class="btn is-primary" href={hitHref(hit, picked)}>
            {blending ? `Blend with ${picked.name} →` : `Open ${hit.name} →`}
          </a>
          {blending ? (
            <a href={`/play/artist/${hit.id}`}>Play {hit.name} alone</a>
          ) : (
            picked === null && (
              <a
                href={`/play/artists?${new URLSearchParams({ q: query, with: String(hit.id), n: hit.name })}`}
              >
                Blend with another artist
              </a>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function hitRow(hit: ArtistHit, picked: Picked) {
  return (
    <li key={hit.id}>
      <a href={hitHref(hit, picked)}>
        {artistArt(hit, "artist-hit-art", 56)}
        <span class="artist-hit-name">
          <b>{hit.name}</b>
          <small>{number(hit.fans)} fans</small>
        </span>
        <span class="artist-hit-go" aria-hidden="true">
          ›
        </span>
      </a>
    </li>
  );
}

// `results` is null when the search itself failed, so the page can offer the
// genres instead of a dead end.
export function artistsPage(
  query: string,
  results: ArtistHit[] | null,
  picked: Picked,
  genres: { slug: string; name: string }[],
  user: SignedInUser | null,
) {
  return Page({
    title: "Find an artist · Guess the song",
    user,
    children: (
      <>
        <div class="page-head">
          <p class="meta">
            <a href="/">Guess the song</a>
          </p>
          <h1>Find an artist</h1>
          {picked !== null && (
            <p class="meta">
              Blending with {picked.name}. Pick the second artist, or{" "}
              <a href={`/play/artists?${new URLSearchParams({ q: query })}`}>
                start over
              </a>
              .
            </p>
          )}
        </div>
        <form method="get" action="/play/artists" class="artist-search">
          {picked !== null && (
            <>
              <input type="hidden" name="with" value={picked.id} />
              <input type="hidden" name="n" value={picked.name} />
            </>
          )}
          <label>
            {searchIcon}
            <span class="sr-only">
              {picked === null ? "Artist" : "Second artist"}
            </span>
            <input
              name="q"
              type="search"
              autocomplete="off"
              placeholder="Search any artist"
              value={query}
              required
              {...(query === "" ? { autofocus: true } : {})}
            />
          </label>
        </form>
        {results === null ? (
          <div class="artist-search-down" role="alert">
            <h2>Search is down, try a genre</h2>
            <p>Deezer isn't answering. Genres still work.</p>
            <a class="btn" href={searchHref(query, picked)}>
              Try again
            </a>
          </div>
        ) : query !== "" && results.length === 0 ? (
          <div class="artist-search-empty">
            <h2>No artist called “{query}”</h2>
            <p class="meta">Check the spelling, or play a genre instead.</p>
          </div>
        ) : null}
        {results !== null && results.length > 0 && (
          <div class="artist-results">
            <section class="artist-top" aria-labelledby="top-hit">
              <h2 class="label" id="top-hit">
                Top hit
              </h2>
              {topHit(results[0], picked, query)}
            </section>
            {results.length > 1 && (
              <section class="artist-others" aria-labelledby="others">
                <div class="section-head">
                  <h2 class="label" id="others">
                    Did you mean
                  </h2>
                  <small class="label">{results.length} on Deezer</small>
                </div>
                <ul class="artist-hits">
                  {results.slice(1, 7).map((hit) => hitRow(hit, picked))}
                </ul>
                {results.length > 7 && (
                  <details>
                    <summary>Show all {results.length}</summary>
                    <ul class="artist-hits">
                      {results.slice(7).map((hit) => hitRow(hit, picked))}
                    </ul>
                  </details>
                )}
              </section>
            )}
          </div>
        )}
        {(results === null || (query !== "" && results.length === 0)) && (
          <section class="artist-genres" aria-labelledby="genres">
            <h2 class="label" id="genres">
              Genres
            </h2>
            <form class="chips" method="post" action="/play">
              <input type="hidden" name="mode" value={defaultMode} />
              {genres.map((genre) => (
                <button
                  class="chip"
                  type="submit"
                  name="category"
                  value={genre.slug}
                >
                  {genre.name}
                </button>
              ))}
              <a class="chip" href="/">
                All genres →
              </a>
            </form>
          </section>
        )}
        <p class="meta">
          Artist names, pictures and fan counts come from Deezer. Each reveal
          links to the track on Deezer.
        </p>
      </>
    ),
  });
}

const modeHelp: Record<Mode, string> = {
  easy: "Pick from 4 choices, artist names shown",
  normal: "Pick the title from 4 choices",
  hard: "Type the title",
};

// One form, three submit buttons: CSS shows the one the Who choice names, so
// the page posts to the solo, room or match endpoint without a script.
function startCard(category: Category, user: SignedInUser | null) {
  const who = [
    {
      value: "solo",
      label: "Solo",
      action: "/play",
      go: "Play solo",
      note:
        user === null
          ? `Sign in and your score goes on the ${category.name} board.`
          : `Your score goes on the ${category.name} board.`,
    },
    {
      value: "room",
      label: "With friends",
      action: "/play/room",
      go: "Create a room",
      note: "You get a 6-letter code to share. Switch artists or genres later without a new room.",
    },
    {
      value: "match",
      label: "Random",
      action: "/play/match",
      go: "Find an opponent",
      note: `Waits up to ${matchWaitMs / 1000} s for another player on ${category.name}, then starts.`,
    },
  ];
  return (
    <form class="start-card" method="post" action="/play">
      <h2>Start a game</h2>
      <input type="hidden" name="category" value={category.slug} />
      <fieldset class="start-row">
        <legend class="label">Who</legend>
        <div class="segmented">
          {who.map((option) => (
            <label>
              <input
                type="radio"
                name="who"
                value={option.value}
                {...(option.value === "solo" ? { checked: true } : {})}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset class="start-row start-mode">
        <legend class="label">Mode</legend>
        <div class="segmented">
          {modes.map((mode) => (
            <label>
              <input
                type="radio"
                name="mode"
                value={mode}
                {...(mode === defaultMode ? { checked: true } : {})}
              />
              {modeNames[mode]}
            </label>
          ))}
        </div>
        <p class="hint start-help">
          {modes.map((mode) => (
            <span data-mode={mode}>{modeHelp[mode]}</span>
          ))}
        </p>
      </fieldset>
      {who.map((option) => (
        <div class="start-go" data-who={option.value}>
          <button
            class="btn is-primary is-lg is-block"
            type="submit"
            formaction={option.action}
          >
            <span>
              {option.go}
              {option.value !== "match" &&
                modes.map((mode) => (
                  <span data-mode={mode}> · {modeNames[mode]}</span>
                ))}
            </span>
          </button>
          <p class="hint">{option.note}</p>
        </div>
      ))}
    </form>
  );
}

export function artistPage(
  category: Category,
  profiles: ArtistProfile[],
  songs: Candidate[],
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
) {
  const ids = category.slug.slice("artist-".length).split("-");
  const fans = profiles.reduce((sum, profile) => sum + profile.fans, 0);
  return Page({
    title: `${category.name} · Guess the song`,
    user,
    children: (
      <div class="artist-page">
        <div class="artist-main">
          <p class="meta">
            <a href="/play/artists">Find an artist</a>
          </p>
          <div class="artist-head">
            <div class="artist-photos">
              {profiles.map((profile) =>
                profile.picture === null ? (
                  <span class="artist-photo is-empty" aria-hidden="true">
                    {profile.name.slice(0, 1)}
                  </span>
                ) : (
                  <img
                    class="artist-photo"
                    src={profile.picture}
                    alt=""
                    width="250"
                    height="250"
                  />
                ),
              )}
            </div>
            <div>
              <h1>{category.name}</h1>
              <p class="meta">
                {fans > 0 && `${number(fans)} fans · `}
                {roundsPerGame} rounds, {roundSeconds} s each
              </p>
            </div>
          </div>
          {songs.length > 0 && (
            <section class="artist-songs" aria-labelledby="songs-title">
              <div class="section-head">
                <h2 id="songs-title">In this game</h2>
                <small class="label">From the top tracks</small>
              </div>
              <ul>
                {songs.map((song) => (
                  <li>
                    {song.cover === null ? (
                      <span class="artist-song-art" aria-hidden="true" />
                    ) : (
                      <img
                        class="artist-song-art"
                        src={song.cover}
                        alt=""
                        width="250"
                        height="250"
                        loading="lazy"
                      />
                    )}
                    <b>{song.title}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div class="artist-side">
          {startCard(category, user)}
          {ids.length === 1 && (
            <a
              class="artist-blend"
              href={`/play/artists?with=${ids[0]}&n=${encodeURIComponent(category.name)}`}
            >
              Blend {category.name} with another artist
            </a>
          )}
        </div>
        <div class="artist-board">
          <Section title="Top scores" aside={`Last ${categoryBoardDays} days`}>
            <CategoryBoard entries={entries} />
          </Section>
        </div>
      </div>
    ),
  });
}
