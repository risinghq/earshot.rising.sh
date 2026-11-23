import { Segmented } from "../ui/segmented";
import { Page } from "../ui/shell";
import { EmptyState } from "../ui/empty";
import { BackLink, Monogram, Mosaic, playIcon } from "../ui/person";
import { type Category } from "./catalog";
import {
  type BoardEntry,
  type BoardPeriod,
  type CategoryBoardEntry,
  categoryBoardDays,
} from "./results";
import { defaultMode } from "./rules";
import { type SignedInUser } from "../auth";
import { number } from "../ui/format";

const profileHref = (name: string) => `/u/${encodeURIComponent(name)}`;

const winsText = (wins: number) => `${wins} ${wins === 1 ? "win" : "wins"}`;

// Days are counted in UTC, like every other date on the site.
function daysAgo(finishedAt: number, now: number) {
  const days = Math.floor(now / 86400) - Math.floor(finishedAt / 86400);
  if (days <= 0) return "today";
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function Tally({ correct, rounds }: { correct: number; rounds: number }) {
  return (
    <>
      <span
        class="pips"
        role="img"
        aria-label={`${correct} of ${rounds} right`}
      >
        {Array.from({ length: rounds }, (_, index) => (
          <i class={index < correct ? "on" : undefined} />
        ))}
      </span>
      <span aria-hidden="true">
        {correct}/{rounds}
      </span>
    </>
  );
}

export function CategoryBoard({
  entries,
  you = null,
  now = Date.now() / 1000,
}: {
  entries: CategoryBoardEntry[];
  you?: string | null;
  now?: number;
}) {
  if (entries.length === 0)
    return <p class="hint">No scores in the last {categoryBoardDays} days.</p>;
  return (
    <div class="list-card is-genre">
      <div class="lhead" aria-hidden="true">
        <span>#</span>
        <span>Player</span>
        <span>Correct</span>
        <span>When</span>
        <span class="end">Score</span>
      </div>
      <ol>
        {entries.map((entry, index) => {
          const when =
            entry.finished_at === undefined
              ? null
              : daysAgo(entry.finished_at, now);
          const tally =
            entry.correct == null || !entry.rounds ? null : (
              <Tally correct={entry.correct} rounds={entry.rounds} />
            );
          return (
            <li class={entry.name === you ? "lrow is-you" : "lrow"}>
              <span class="rank">{index + 1}</span>
              <a class="who" href={profileHref(entry.name)}>
                <Monogram name={entry.name} />
                <span class="who-text">
                  <span class="name">{entry.name}</span>
                  {when && <span class="sub is-narrow">{when}</span>}
                </span>
              </a>
              <span class="col tally is-wide">{tally}</span>
              <span class="col is-wide">{when}</span>
              <span class="score-col">
                <b class="points">{number(entry.score)}</b>
                {tally && <span class="tally is-narrow">{tally}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const boardNames: Record<BoardPeriod, string> = {
  week: "This week",
  all: "All time",
};

const bestGameNote = `Each player's best single game, last ${categoryBoardDays} days.`;

export function categoryBoardPage(
  category: Category,
  entries: CategoryBoardEntry[],
  user: SignedInUser | null,
  categories: Category[] = [],
) {
  return Page({
    title: `${category.name} scores · Guess the song`,
    user,
    nav: "board",
    children: (
      <div class="board is-genre">
        <div class="board-main">
          <BackLink href="/play/board" label="Points board" />
          <section class="hero-stage">
            <Mosaic seed={category.slug} />
            <div class="hero-text">
              <p class="kicker">Genre board</p>
              <h1 class="hero-title">{category.name}</h1>
              <p class="hero-sub">{bestGameNote}</p>
            </div>
            <form class="hero-foot" method="post" action="/play">
              <input type="hidden" name="category" value={category.slug} />
              <input type="hidden" name="mode" value={defaultMode} />
              <button class="btn is-primary is-play" type="submit">
                {playIcon}
                Play {category.name}
              </button>
            </form>
          </section>
          <CategoryBoard entries={entries} you={user?.name ?? null} />
        </div>
        <GenreRail
          categories={categories}
          current={category.slug}
          title="Other genres"
        />
      </div>
    ),
  });
}

// The current genre leads the rail, so on a phone it is the first chip in
// the scrolling row.
function GenreRail({
  categories,
  current = null,
  title,
}: {
  categories: Category[];
  current?: string | null;
  title: string;
}) {
  const genres = categories.filter((category) => category.feed !== "mine");
  if (genres.length === 0) return null;
  const ordered =
    current === null
      ? genres
      : [
          ...genres.filter((category) => category.slug === current),
          ...genres.filter((category) => category.slug !== current),
        ];
  return (
    <section
      class={current === null ? "rail" : "rail is-scroll"}
      aria-label="Scores by genre"
    >
      <header>
        <div class="sect-title">
          <h2>{title}</h2>
          {current === null && (
            <span class="aside is-narrow">
              Best game · {categoryBoardDays} days
            </span>
          )}
        </div>
        {current === null && <p class="is-wide">{bestGameNote}</p>}
      </header>
      <nav class="genre-chips">
        {ordered.map((category) => (
          <a
            class="chip-genre"
            href={`/play/board?category=${category.slug}`}
            aria-current={category.slug === current ? "page" : undefined}
          >
            <Mosaic seed={category.slug} />
            <span>{category.name}</span>
          </a>
        ))}
      </nav>
    </section>
  );
}

const podiumShown = 3;

const rowsShown = 12;

function PodiumCard({
  entry,
  place,
  period,
}: {
  entry: BoardEntry;
  place: number;
  period: BoardPeriod;
}) {
  const wins = winsText(entry.wins);
  return (
    <li>
      <span class="rank">
        {place === 1 ? (
          <>
            #1
            <span class="is-wide">
              {" "}
              {period === "week" ? "this week" : "all time"} · {wins}
            </span>
          </>
        ) : (
          <>
            <span class="is-wide">#</span>
            {place}
            <span class="is-wide"> · {wins}</span>
          </>
        )}
      </span>
      <Monogram name={entry.name} />
      <a class="name" href={profileHref(entry.name)}>
        {entry.name}
      </a>
      <span class="points">{number(entry.points)}</span>
      <span class="wins">{wins}</span>
    </li>
  );
}

function BoardRow({
  entry,
  place,
  you,
}: {
  entry: BoardEntry;
  place: number;
  you: string | null;
}) {
  return (
    <li class={entry.name === you ? "lrow is-you" : "lrow"}>
      <span class="rank">{place}</span>
      <a class="who" href={profileHref(entry.name)}>
        <Monogram name={entry.name} />
        <span class="who-text">
          <span class="name">{entry.name}</span>
          <span class="sub is-narrow">{winsText(entry.wins)}</span>
        </span>
      </a>
      <span class="col end is-wide">{entry.wins}</span>
      <span class="points">{number(entry.points)}</span>
    </li>
  );
}

export function boardPage(
  entries: BoardEntry[],
  period: BoardPeriod,
  user: SignedInUser | null,
  categories: Category[] = [],
) {
  const you = user?.name ?? null;
  const rest = entries.slice(podiumShown);
  const shown = rest.slice(0, rowsShown - podiumShown);
  const more = rest.slice(rowsShown - podiumShown);
  return Page({
    title: "Points board · Guess the song",
    user,
    nav: "board",
    children: (
      <div class="board">
        <div class="board-main">
          <header class="head">
            <div>
              <h1>Points board</h1>
              <p class="lead">
                Total points from finished games. The week starts Monday 00:00
                UTC.
              </p>
            </div>
            <Segmented
              label="Board period"
              options={(["week", "all"] as const).map((value) => ({
                label: boardNames[value],
                href: `/play/board?period=${value}`,
                current: period === value,
              }))}
            />
          </header>
          {entries.length === 0 ? (
            <EmptyState
              title="No scored games yet"
              body="Signed-in players land here when they finish a game. Play one to open the board."
              action={{ href: "/", label: "Play a game" }}
            />
          ) : (
            <>
              <ol class="podium" aria-label="Top three">
                {entries.slice(0, podiumShown).map((entry, index) => (
                  <PodiumCard entry={entry} place={index + 1} period={period} />
                ))}
              </ol>
              {rest.length > 0 && (
                <div class="list-card board-list">
                  <div class="lhead" aria-hidden="true">
                    <span>#</span>
                    <span>Player</span>
                    <span class="end">Wins</span>
                    <span class="end">Points</span>
                  </div>
                  <ol start={podiumShown + 1}>
                    {shown.map((entry, index) => (
                      <BoardRow
                        entry={entry}
                        place={podiumShown + 1 + index}
                        you={you}
                      />
                    ))}
                  </ol>
                  {more.length > 0 && (
                    <details class="list-more">
                      <summary>
                        Show ranks {rowsShown + 1}–{entries.length}
                      </summary>
                      <ol start={rowsShown + 1}>
                        {more.map((entry, index) => (
                          <BoardRow
                            entry={entry}
                            place={rowsShown + 1 + index}
                            you={you}
                          />
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <GenreRail categories={categories} title="Board by genre" />
      </div>
    ),
  });
}
