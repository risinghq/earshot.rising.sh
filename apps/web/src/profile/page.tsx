import type { SignedInUser } from "../account/auth";
import { sourceNames } from "../listening/names";
import { DayBars, dayBuckets } from "../ui/bars";
import { Cover, Monogram, soundMark } from "../ui/person";
import { Segmented } from "../ui/segmented";
import { Page } from "../ui/shell";
import type { Period, PeriodStats } from "./stats";

export const periods: Period[] = ["week", "month", "all"];

export type Relation = "friends" | "sent" | "none" | "self" | "out";

const periodNames: Record<Period, string> = {
  week: "Week",
  month: "Month",
  all: "All time",
};

// Bars per chart: a week shows each day; month and all time show the last
// 30 days.
const chartDays: Record<Period, number> = { week: 7, month: 30, all: 30 };

const emptyTitles: Record<Period, string> = {
  week: "No plays in the last 7 days",
  month: "No plays in the last 30 days",
  all: "No plays yet",
};

function sourceList(kinds: string | null) {
  const names = new Set(
    (kinds?.split(",") ?? []).map((kind) => sourceNames[kind] ?? kind),
  );
  return [...names].sort();
}

const updatedText = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

const trackSeed = (track: { title: string; artist: string }) =>
  `${track.title} ${track.artist}`;

function ProfileActions({
  name,
  period,
  relation,
}: {
  name: string;
  period: Period;
  relation: Relation;
}) {
  const path = `/u/${encodeURIComponent(name)}`;
  return (
    <div class="actions" id="profile-actions">
      {relation === "friends" && (
        <a class="btn is-sm" href="/friends">
          Friends
        </a>
      )}
      {relation === "sent" && (
        <span class="btn is-sm" aria-disabled="true">
          Request sent
        </span>
      )}
      {relation === "none" && (
        <form
          method="post"
          action="/friends/request"
          data-inline="profile-actions"
        >
          <input type="hidden" name="name" value={name} />
          <input type="hidden" name="next" value={path} />
          <button class="btn is-sm is-primary" type="submit">
            Add friend
          </button>
        </form>
      )}
      <a class="btn is-sm" href={`${path}.json?period=${period}`}>
        <span class="code-mark" aria-hidden="true">
          {"{ }"}
        </span>
        Data as JSON
      </a>
    </div>
  );
}

// A cover shows the Deezer image when one was found, over a colour tile
// hashed from a seed: a track's own title and artist, and for an artist the
// seed of their top track, so an artist's disc matches that track's cover.
function TopList({
  title,
  rows,
  artists = false,
}: {
  title: string;
  rows: {
    title: string;
    artist?: string;
    plays: number;
    // Snapshots cached before images existed carry none.
    image?: string | null;
    seed: string;
  }[];
  artists?: boolean;
}) {
  const max = Math.max(1, rows[0]?.plays ?? 1);
  return (
    <section class={artists ? "top-card is-artists" : "top-card"}>
      <h2>{title}</h2>
      <ol>
        {rows.map((row, index) => {
          const meter = (
            <span class="meter" aria-hidden="true">
              <span style={`--pct: ${((row.plays / max) * 100).toFixed(1)}%`} />
            </span>
          );
          return (
            <li class="trow">
              <span class="rank">{index + 1}</span>
              <Cover seed={row.seed} src={row.image} disc={artists} />
              <div class="body">
                <div class="line">
                  <span class="title">{row.title}</span>
                  <b class="count">{row.plays}</b>
                </div>
                {row.artist !== undefined && (
                  <span class="artist">{row.artist}</span>
                )}
                {meter}
              </div>
              <div class="stat is-wide" aria-hidden="true">
                {meter}
                <b>{row.plays}</b>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function profilePage(
  snapshot: PeriodStats,
  origin: string,
  kinds: string | null,
  user: SignedInUser | null,
  relation: Relation,
) {
  const name = snapshot.user.name;
  const cardUrl = `${origin}/u/${encodeURIComponent(name)}.svg`;
  const updatedDay = new Date(snapshot.updated_at * 1000)
    .toISOString()
    .slice(0, 10);
  const days = dayBuckets(
    snapshot.daily,
    updatedDay,
    chartDays[snapshot.period],
  );
  const empty = snapshot.plays === 0;
  return Page({
    title: snapshot.user.name,
    head: (
      <>
        <meta
          property="og:title"
          content={`${snapshot.user.name}'s listening profile`}
        />
        <meta property="og:image" content={cardUrl} />
      </>
    ),
    user,
    children: (
      <>
        <section class="profile-hero">
          <div class="profile-side">
            <div class="profile-id">
              <Monogram name={name} />
              <div>
                <h1 class="profile-name">{name}</h1>
                <div class="profile-meta">
                  {sourceList(kinds).map((source) => (
                    <span class="source-pill">{source}</span>
                  ))}
                  <span class="updated">
                    Updated{" "}
                    <time
                      datetime={new Date(
                        snapshot.updated_at * 1000,
                      ).toISOString()}
                    >
                      {updatedText(snapshot.updated_at)} UTC
                    </time>
                  </span>
                </div>
              </div>
            </div>
            {!empty && (
              <dl class="stage-stats">
                {(
                  [
                    ["Plays", snapshot.plays],
                    ["Tracks", snapshot.unique_tracks],
                    ["Artists", snapshot.unique_artists],
                  ] as const
                ).map(([label, value]) => (
                  <div>
                    <dt>{label}</dt>
                    <dd>{value.toLocaleString("en-US")}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div class="profile-main">
            <Segmented
              label="Time period"
              stage
              swap="main"
              options={periods.map((period) => ({
                label: periodNames[period],
                href: `?period=${period}`,
                current: snapshot.period === period,
              }))}
            />
            {empty ? (
              <div class="profile-empty">
                <h2>{emptyTitles[snapshot.period]}</h2>
                <p>
                  Plays appear here once a connected source reports them.
                  {snapshot.period !== "all" &&
                    " A longer period may hold some."}
                </p>
                {snapshot.period !== "all" && (
                  <div class="actions" data-swap="main">
                    {snapshot.period === "week" && (
                      <a class="btn is-stage" href="?period=month">
                        See Month
                      </a>
                    )}
                    <a
                      class={
                        snapshot.period === "week"
                          ? "btn is-stage-2"
                          : "btn is-stage"
                      }
                      href="?period=all"
                    >
                      All time
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <div class="stage-chart">
                <div class="chart-head">
                  <span>Plays per day</span>
                  <span>
                    {snapshot.period === "week" ? "UTC" : "Last 30 days · UTC"}
                  </span>
                </div>
                <DayBars days={days} />
              </div>
            )}
          </div>
        </section>
        <div class="note-row">
          {!empty && (
            <p class="for-you-note">
              {soundMark}
              These plays tune {name}'s For you mix.
            </p>
          )}
          <ProfileActions
            name={name}
            period={snapshot.period}
            relation={relation}
          />
        </div>
        {!empty && (
          <div class="top-pair">
            <TopList
              title="Top tracks"
              rows={snapshot.top_tracks.map((item) => ({
                ...item,
                seed: trackSeed(item),
              }))}
            />
            <TopList
              title="Top artists"
              artists
              rows={snapshot.top_artists.map((item) => {
                const top = snapshot.top_tracks.find(
                  (track) => track.artist === item.artist,
                );
                return {
                  title: item.artist,
                  plays: item.plays,
                  image: item.image,
                  seed: top ? trackSeed(top) : item.artist,
                };
              })}
            />
          </div>
        )}
      </>
    ),
  });
}
