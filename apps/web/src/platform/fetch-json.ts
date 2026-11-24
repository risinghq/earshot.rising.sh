import * as v from "valibot";

const timeoutMs = 8000;

export class FeedError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

// Null when the body is not JSON or does not match the schema.
export async function readJson<T>(
  response: Response,
  schema: v.GenericSchema<unknown, T>,
): Promise<T | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const parsed = v.safeParse(schema, body);
  return parsed.success ? parsed.output : null;
}

// The timer is cleared once the body is read. AbortSignal.timeout's timer
// would stay pending for the full 8 s, and a pending timer keeps a Durable
// Object from hibernating or being evicted.
export async function fetchJson<T>(
  url: string,
  schema: v.GenericSchema<unknown, T>,
): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        signal: abort.signal,
        headers: { "user-agent": "music-stats-web" },
      });
    } catch (error) {
      throw new FeedError(String(error), url);
    }
    if (!response.ok)
      throw new FeedError(`feed answered ${response.status}`, url);
    const body = await readJson(response, schema);
    if (body === null) throw new FeedError("unexpected body", url);
    return body;
  } finally {
    clearTimeout(timer);
  }
}
