export const maxSourcesPerPull = 10;

export const idlePullDelay = (idlePulls: number) =>
  Math.min(6 * 60 * 60, 15 * 60 * 2 ** idlePulls);

export function nextPullDelay(inserted: number, idlePulls: number) {
  return inserted > 0 ? 15 * 60 : idlePullDelay(idlePulls);
}

export const nextUtcMidnight = (now: number) =>
  Math.floor(now / 86400) * 86400 + 86400;

const dailyLimitPattern = /daily row (?:read|write) limit/i;

// Drizzle wraps a D1 failure as "Failed query: <sql>" and keeps the D1 error
// in `cause`, so the message that names the failure is the innermost one.
export function failureMessage(error: unknown) {
  let inner = error;
  while (inner instanceof Error && inner.cause instanceof Error)
    inner = inner.cause;
  return inner instanceof Error ? inner.message : "Source pull failed";
}

export const isDailyLimit = (error: unknown) =>
  dailyLimitPattern.test(failureMessage(error));
