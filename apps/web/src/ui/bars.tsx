export interface DayCount {
  day: string;
  plays: number;
}

const dayNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const dayNumber = (day: string) => Math.floor(Date.parse(day) / 86400_000);
const dayString = (number: number) =>
  new Date(number * 86400_000).toISOString().slice(0, 10);
const shortDate = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

// The snapshot lists only days with plays. A chart shows every day of the
// window, so the gaps become zero bars.
export function dayBuckets(
  daily: DayCount[],
  lastDay: string,
  count: number,
): DayCount[] {
  const plays = new Map(daily.map((entry) => [entry.day, entry.plays]));
  const last = dayNumber(lastDay);
  return Array.from({ length: count }, (_, index) => {
    const day = dayString(last - count + 1 + index);
    return { day, plays: plays.get(day) ?? 0 };
  });
}

// A week shows a weekday and count under each bar; a longer window is dense
// and labels only its ends.
export function DayBars({ days }: { days: DayCount[] }) {
  const max = Math.max(1, ...days.map((entry) => entry.plays));
  const dense = days.length > 7;
  return (
    <>
      <ol
        class={dense ? "day-bars is-dense" : "day-bars"}
        aria-label="Plays per day"
      >
        {days.map((entry) => (
          <li
            class={entry.plays === 0 ? "is-zero" : undefined}
            style={`--v: ${(entry.plays / max).toFixed(3)}`}
            title={`${entry.day}: ${entry.plays} plays`}
          >
            <span class="bar-count" aria-hidden="true">
              {entry.plays}
            </span>
            <span class="bar-fill" aria-hidden="true" />
            <span class="bar-day" aria-hidden="true">
              {dayNames[new Date(`${entry.day}T00:00:00Z`).getUTCDay()]}
            </span>
            <span class="sr-only">
              {entry.day}: {entry.plays} plays
            </span>
          </li>
        ))}
      </ol>
      {dense && days.length > 0 && (
        <div class="chart-axis" aria-hidden="true">
          <span>{shortDate(days[0]!.day)}</span>
          <span>{shortDate(days[days.length - 1]!.day)}</span>
        </div>
      )}
    </>
  );
}
